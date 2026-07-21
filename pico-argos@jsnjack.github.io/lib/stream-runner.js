// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {buildPluginEnvironment} from './process-environment.js';
import {parseProtocolMessage} from './protocol.js';
import {StreamFramer, StreamStderr} from './stream-framing.js';

const READ_BYTES = 8 * 1_024;
const TERMINATE_GRACE_MS = 250;
const PIPE_DRAIN_MS = 250;

/** Describes one supervised stream child failure. */
export class StreamRunError extends Error {
    constructor(kind, message, stderr = '', details = null) {
        super(message);
        this.name = 'StreamRunError';
        this.kind = kind;
        this.stderr = stderr;
        this.details = details;
    }
}

/** Owns bounded asynchronous pipes and liveness for stream direct children. */
export class StreamRunner {
    constructor({clock, onPhase = null, onEvent = null, nextRunId = null}) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('StreamRunner requires a monotonic clock');
        this._clock = clock;
        this._onPhase = onPhase;
        this._onEvent = onEvent;
        this._localRunId = 0;
        this._nextRunId = nextRunId ?? (() => ++this._localRunId);
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

        const runId = this._nextRunId();
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
        this._emit('launch-begin', manifest.id, runId, launchBeginUs);
        let process;
        try {
            process = launcher.spawnv(argv);
        } catch (error) {
            this._onPhase?.('spawn-call', this._clock.nowUs() - launchBeginUs, manifest.id);
            const spawnReturnUs = this._clock.nowUs();
            this._emit(
                'spawn-return', manifest.id, runId, spawnReturnUs, 0, {spawned: false});
            throw new StreamRunError(
                'spawn',
                `Starting stream ${manifest.id}: ${error.message}`,
                '',
                {runId, launchBeginUs, spawnReturnUs});
        }
        const spawnReturnUs = this._clock.nowUs();
        this._onPhase?.('spawn-call', spawnReturnUs - launchBeginUs, manifest.id);
        this._emit('spawn-return', manifest.id, runId, spawnReturnUs, 0, {
            spawned: true,
            niceApplied: manifest.nice === null || this._nicePath !== null,
        });

        const context = {
            process,
            cancellable,
            failure: null,
            cancelled: false,
            exited: false,
            exitFailure: null,
            started: false,
            drainSourceId: 0,
            forceSourceId: 0,
            startupSourceId: 0,
            heartbeatSourceId: 0,
            stderr: new StreamStderr(this._clock.nowUs()),
            firstStdoutUs: null,
            processExitUs: null,
            stdoutBytes: 0,
            stderrBytes: 0,
            messageSequence: 0,
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
                context.stdoutBytes += chunk.length;
                this._emit(
                    'stdout-bytes',
                    manifest.id,
                    runId,
                    this._clock.nowUs(),
                    context.messageSequence,
                    {bytes: chunk.length});
                if (context.firstStdoutUs === null) {
                    context.firstStdoutUs = this._clock.nowUs();
                    this._onPhase?.(
                        'first-byte',
                        context.firstStdoutUs - launchBeginUs,
                        manifest.id);
                    this._emit(
                        'first-stdout-byte',
                        manifest.id,
                        runId,
                        context.firstStdoutUs);
                }
                const decodeBeginUs = this._clock.nowUs();
                this._emit('decode-begin', manifest.id, runId, decodeBeginUs);
                const lines = framer.push(chunk, decodeBeginUs);
                const decodeEndUs = this._clock.nowUs();
                this._emit('decode-end', manifest.id, runId, decodeEndUs);
                this._onPhase?.('decode', decodeEndUs - decodeBeginUs, manifest.id);
                for (const raw of lines) {
                    context.messageSequence++;
                    this._emit(
                        'stream-line-complete',
                        manifest.id,
                        runId,
                        this._clock.nowUs(),
                        context.messageSequence);
                    const message = onMessage === null
                        ? parseProtocolMessage(raw, {allowHeartbeat: true})
                        : onMessage(raw, {
                            runId,
                            sequence: context.messageSequence,
                        });
                    if (message?.kind !== 'snapshot' && message?.kind !== 'heartbeat')
                        throw new Error('Stream message callback must return a parsed message');
                    if (message.kind === 'snapshot' && !context.started) {
                        context.started = true;
                        removeSource(context, 'startupSourceId');
                        this._emit(
                            'stream-first-snapshot',
                            manifest.id,
                            runId,
                            this._clock.nowUs(),
                            context.messageSequence);
                        onHealthy?.(this._clock.nowUs());
                    }
                    if (message.kind === 'heartbeat') {
                        this._emit(
                            'stream-heartbeat',
                            manifest.id,
                            runId,
                            this._clock.nowUs(),
                            context.messageSequence);
                    }
                    if (message.kind === 'snapshot' || context.started)
                        this._resetHeartbeat(context, manifest);
                }
            },
            () => {
                framer.finish();
                this._emit('stdout-eof', manifest.id, runId, this._clock.nowUs());
                if (!context.cancelled && !context.exited)
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
            chunk => {
                context.stderrBytes += chunk.length;
                this._emit(
                    'stderr-bytes',
                    manifest.id,
                    runId,
                    this._clock.nowUs(),
                    context.messageSequence,
                    {bytes: chunk.length});
                context.stderr.push(chunk, this._clock.nowUs());
            },
            () => this._emit(
                'stderr-eof', manifest.id, runId, this._clock.nowUs())).catch(error => {
            this._terminate(
                context,
                error.kind ?? 'stderr-read',
                `Reading stream ${manifest.id} stderr: ${error.message}`);
        });
        const waitPromise = waitForProcess(process).catch(error => {
            this._terminate(
                context,
                'wait',
                `Waiting for stream ${manifest.id}: ${error.message}`);
            return waitForProcess(process);
        }).then(() => {
            context.exited = true;
            context.processExitUs = this._clock.nowUs();
            this._emit('process-exit', manifest.id, runId, context.processExitUs);
            removeSource(context, 'forceSourceId');
            if (!context.cancelled && context.failure === null) {
                if (process.get_if_exited()) {
                    const status = process.get_exit_status();
                    context.exitFailure = {
                        kind: status === 0 ? 'unexpected-exit' : 'nonzero-exit',
                        message: `Stream ${manifest.id} exited with status ${status}`,
                    };
                } else {
                    context.exitFailure = {
                        kind: 'signal',
                        message: `Stream ${manifest.id} exited after signal ` +
                            `${process.get_term_sig()}`,
                    };
                }
            }
            context.drainSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                PIPE_DRAIN_MS,
                () => {
                    context.drainSourceId = 0;
                    cancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });
        });

        try {
            await Promise.all([stdoutPromise, stderrPromise, waitPromise]);
        } finally {
            removeSource(context, 'startupSourceId');
            removeSource(context, 'heartbeatSourceId');
            removeSource(context, 'forceSourceId');
            removeSource(context, 'drainSourceId');
            if (this._active.get(manifest.id) === context)
                this._active.delete(manifest.id);
        }

        const failure = context.failure ?? context.exitFailure ?? {
            kind: 'cancelled',
            message: `Stream ${manifest.id} was cancelled`,
        };
        const details = {
            runId,
            launchBeginUs,
            spawnReturnUs,
            firstStdoutUs: context.firstStdoutUs,
            processExitUs: context.processExitUs,
            stdoutBytes: context.stdoutBytes,
            stderrBytes: context.stderrBytes,
            messages: context.messageSequence,
        };
        if (context.processExitUs !== null) {
            this._onPhase?.('child-wall', context.processExitUs - launchBeginUs, manifest.id);
            this._onPhase?.(
                'pipe-drain',
                this._clock.nowUs() - context.processExitUs,
                manifest.id);
        }
        throw new StreamRunError(
            failure.kind,
            failure.message,
            context.stderr.text(),
            details);
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
            if (context.drainSourceId === 0) {
                context.drainSourceId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    PIPE_DRAIN_MS,
                    () => {
                        context.drainSourceId = 0;
                        context.cancellable.cancel();
                        return GLib.SOURCE_REMOVE;
                    });
            }
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

    _emit(kind, pluginId, runId, timestampUs, sequence = 0, extra = {}) {
        this._onEvent?.({kind, pluginId, runId, timestampUs, sequence, ...extra});
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
