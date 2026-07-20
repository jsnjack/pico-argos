// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {buildPluginEnvironment} from './process-environment.js';
import {parseProtocolMessage} from './protocol.js';
import {StreamFramer, StreamStderr} from './stream-framing.js';

const READ_BYTES = 8 * 1_024;
const TERMINATE_GRACE_MS = 250;

/** Describes one supervised stream child failure. */
export class StreamRunError extends Error {
    constructor(kind, message, stderr = '') {
        super(message);
        this.name = 'StreamRunError';
        this.kind = kind;
        this.stderr = stderr;
    }
}

/** Owns bounded asynchronous pipes and liveness for stream direct children. */
export class StreamRunner {
    constructor({clock, onPhase = null}) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('StreamRunner requires a monotonic clock');
        this._clock = clock;
        this._onPhase = onPhase;
        this._active = new Map();
        this._nicePath = GLib.find_program_in_path('nice');
    }

    /** Runs one stream until cancellation, exit, or a protocol boundary failure. */
    async run(manifest, {
        workingDirectory = null,
        onMessage = null,
        onHealthy = null,
    } = {}) {
        if (manifest.mode !== 'stream')
            throw new TypeError('StreamRunner accepts stream manifests only');
        if (this._active.has(manifest.id))
            throw new StreamRunError('overlap', `Plugin ${manifest.id} is already running`);

        const cancellable = new Gio.Cancellable();
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.set_environ(buildPluginEnvironment(manifest));
        launcher.set_cwd(workingDirectory ?? GLib.path_get_dirname(manifest.command[0]));
        const argv = manifest.nice === null || this._nicePath === null
            ? manifest.command
            : [this._nicePath, '-n', String(manifest.nice), ...manifest.command];

        const launchBeginUs = this._clock.nowUs();
        let process;
        try {
            process = launcher.spawnv(argv);
        } catch (error) {
            this._onPhase?.('spawn-call', this._clock.nowUs() - launchBeginUs, manifest.id);
            throw new StreamRunError('spawn', `Starting stream ${manifest.id}: ${error.message}`);
        }
        this._onPhase?.('spawn-call', this._clock.nowUs() - launchBeginUs, manifest.id);

        const context = {
            process,
            cancellable,
            failure: null,
            cancelled: false,
            exited: false,
            started: false,
            forceSourceId: 0,
            startupSourceId: 0,
            heartbeatSourceId: 0,
            stderr: new StreamStderr(this._clock.nowUs()),
        };
        this._active.set(manifest.id, context);
        context.startupSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            manifest.startupTimeoutMs,
            () => {
                context.startupSourceId = 0;
                this._terminate(
                    context,
                    'startup-timeout',
                    `Stream ${manifest.id} did not emit an initial snapshot`);
                return GLib.SOURCE_REMOVE;
            });

        const framer = new StreamFramer({
            maxMessagesPerSecond: manifest.maxMessagesPerSecond,
            maxBytesPerMinute: manifest.maxBytesPerMinute,
            nowUs: this._clock.nowUs(),
        });
        const stdoutPromise = readStream(
            process.get_stdout_pipe(),
            cancellable,
            chunk => {
                const lines = framer.push(chunk, this._clock.nowUs());
                for (const raw of lines) {
                    const message = onMessage === null
                        ? parseProtocolMessage(raw, {allowHeartbeat: true})
                        : onMessage(raw);
                    if (message?.kind !== 'snapshot' && message?.kind !== 'heartbeat')
                        throw new Error('Stream message callback must return a parsed message');
                    if (message.kind === 'snapshot' && !context.started) {
                        context.started = true;
                        removeSource(context, 'startupSourceId');
                        onHealthy?.(this._clock.nowUs());
                    }
                    if (message.kind === 'snapshot' || context.started)
                        this._resetHeartbeat(context, manifest);
                }
            },
            () => {
                framer.finish();
                if (!context.cancelled)
                    this._terminate(context, 'stdout-eof', `Stream ${manifest.id} closed stdout`);
            }).catch(error => {
            this._terminate(
                context,
                error.kind ?? 'stdout-read',
                `Reading stream ${manifest.id} stdout: ${error.message}`);
        });
        const stderrPromise = readStream(
            process.get_stderr_pipe(),
            cancellable,
            chunk => context.stderr.push(chunk, this._clock.nowUs()),
            () => {}).catch(error => {
            this._terminate(
                context,
                error.kind ?? 'stderr-read',
                `Reading stream ${manifest.id} stderr: ${error.message}`);
        });
        const waitPromise = waitForProcess(process).then(() => {
            context.exited = true;
            removeSource(context, 'forceSourceId');
            if (!context.cancelled && context.failure === null) {
                if (process.get_if_exited()) {
                    const status = process.get_exit_status();
                    this._fail(
                        context,
                        status === 0 ? 'unexpected-exit' : 'nonzero-exit',
                        `Stream ${manifest.id} exited with status ${status}`);
                } else {
                    this._fail(
                        context,
                        'signal',
                        `Stream ${manifest.id} exited after signal ${process.get_term_sig()}`);
                }
            }
            cancellable.cancel();
        });

        try {
            await Promise.all([stdoutPromise, stderrPromise, waitPromise]);
        } finally {
            removeSource(context, 'startupSourceId');
            removeSource(context, 'heartbeatSourceId');
            removeSource(context, 'forceSourceId');
            if (this._active.get(manifest.id) === context)
                this._active.delete(manifest.id);
        }

        const failure = context.failure ?? {
            kind: 'cancelled',
            message: `Stream ${manifest.id} was cancelled`,
        };
        throw new StreamRunError(failure.kind, failure.message, context.stderr.text());
    }

    /** Terminates one active stream direct child. */
    cancel(pluginId) {
        const context = this._active.get(pluginId);
        if (context === undefined)
            return;
        context.cancelled = true;
        this._terminate(context, 'cancelled', `Stream ${pluginId} was cancelled`);
    }

    /** Terminates every active stream direct child. */
    cancelAll() {
        for (const pluginId of this._active.keys())
            this.cancel(pluginId);
    }

    _resetHeartbeat(context, manifest) {
        if (manifest.heartbeatTimeoutMs === 0)
            return;
        removeSource(context, 'heartbeatSourceId');
        context.heartbeatSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            manifest.heartbeatTimeoutMs,
            () => {
                context.heartbeatSourceId = 0;
                this._terminate(
                    context,
                    'heartbeat-timeout',
                    `Stream ${manifest.id} missed its heartbeat deadline`);
                return GLib.SOURCE_REMOVE;
            });
    }

    _fail(context, kind, message) {
        context.failure ??= {kind, message};
    }

    _terminate(context, kind, message) {
        this._fail(context, kind, message);
        if (context.exited) {
            context.cancellable.cancel();
            return;
        }
        if (context.forceSourceId !== 0)
            return;
        try {
            context.process.send_signal(15);
        } catch (_error) {
            context.process.force_exit();
        }
        context.forceSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TERMINATE_GRACE_MS,
            () => {
                context.forceSourceId = 0;
                if (!context.exited)
                    context.process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
    }
}

function readStream(stream, cancellable, onChunk, onEof) {
    return new Promise((resolve, reject) => {
        const read = () => {
            stream.read_bytes_async(
                READ_BYTES,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (source, result) => {
                    let chunk;
                    try {
                        const bytes = source.read_bytes_finish(result);
                        chunk = new Uint8Array(bytes.get_data());
                    } catch (error) {
                        if (cancellable.is_cancelled()) {
                            resolve();
                            return;
                        }
                        reject(error);
                        return;
                    }
                    if (chunk.length === 0) {
                        try {
                            onEof();
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                        return;
                    }
                    try {
                        onChunk(chunk);
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    read();
                });
        };
        read();
    });
}

function waitForProcess(process) {
    return new Promise((resolve, reject) => {
        process.wait_async(null, (source, result) => {
            try {
                source.wait_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function removeSource(context, property) {
    if (context[property] === 0)
        return;
    GLib.source_remove(context[property]);
    context[property] = 0;
}
