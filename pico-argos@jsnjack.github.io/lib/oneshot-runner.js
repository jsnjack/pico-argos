// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {buildPluginEnvironment} from './process-environment.js';

const READ_BYTES = 8 * 1_024;
const MAX_STDOUT_BYTES = 64 * 1_024;
const MAX_STDERR_BYTES = 8 * 1_024;
const TERMINATE_GRACE_MS = 250;

/** Describes one bounded one-shot execution failure. */
export class OneShotRunError extends Error {
    constructor(kind, message, stderr = '', details = null) {
        super(message);
        this.name = 'OneShotRunError';
        this.kind = kind;
        this.stderr = stderr;
        this.details = details;
    }
}

/** Starts, drains, limits, terminates, and reaps one-shot plugin processes. */
export class OneShotRunner {
    constructor({clock, onPhase = null, onEvent = null, nextRunId = null}) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('OneShotRunner requires a monotonic clock');
        this._clock = clock;
        this._onPhase = onPhase;
        this._onEvent = onEvent;
        this._localRunId = 0;
        this._nextRunId = nextRunId ?? (() => ++this._localRunId);
        this._active = new Map();
        this._generation = 0;
        this._nicePath = GLib.find_program_in_path('nice');
    }

    /** Runs one normalized one-shot manifest and returns its bounded stdout. */
    async run(manifest, {menuOpen = false, workingDirectory = null} = {}) {
        if (manifest.mode !== 'oneshot')
            throw new TypeError('OneShotRunner accepts one-shot manifests only');
        if (this._active.has(manifest.id))
            throw new OneShotRunError('overlap', `Plugin ${manifest.id} is already running`);

        const runId = this._nextRunId();
        const generation = ++this._generation;
        const cancellable = new Gio.Cancellable();
        const argv = this._buildArgv(manifest);
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.set_environ(buildPluginEnvironment(manifest, menuOpen));
        launcher.set_cwd(workingDirectory ?? GLib.path_get_dirname(manifest.command[0]));

        const launchBeginUs = this._clock.nowUs();
        this._emit('launch-begin', manifest.id, runId, launchBeginUs);
        let process;
        try {
            process = launcher.spawnv(argv);
        } catch (error) {
            this._onPhase?.('spawn-call', this._clock.nowUs() - launchBeginUs, manifest.id);
            const spawnReturnUs = this._clock.nowUs();
            this._emit('spawn-return', manifest.id, runId, spawnReturnUs, {spawned: false});
            throw new OneShotRunError(
                'spawn',
                `Starting plugin ${manifest.id}: ${error.message}`,
                '',
                {runId, launchBeginUs, spawnReturnUs});
        }
        const spawnReturnUs = this._clock.nowUs();
        this._onPhase?.('spawn-call', spawnReturnUs - launchBeginUs, manifest.id);
        this._emit('spawn-return', manifest.id, runId, spawnReturnUs, {
            spawned: true,
            niceApplied: manifest.nice === null || this._nicePath !== null,
        });

        const context = {
            generation,
            process,
            cancellable,
            failure: null,
            forceSourceId: 0,
            timeoutSourceId: 0,
            exited: false,
            firstStdoutUs: null,
            processExitUs: null,
        };
        this._active.set(manifest.id, context);
        context.timeoutSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            manifest.timeoutMs,
            () => {
                context.timeoutSourceId = 0;
                this._terminate(context, 'timeout', `Plugin ${manifest.id} timed out`);
                return GLib.SOURCE_REMOVE;
            });

        const stdoutPromise = drainBounded(
            process.get_stdout_pipe(),
            MAX_STDOUT_BYTES,
            cancellable,
            () => this._terminate(
                context,
                'stdout-limit',
                `Plugin ${manifest.id} exceeded ${MAX_STDOUT_BYTES} stdout bytes`),
            {
                onFirstByte: () => {
                    context.firstStdoutUs ??= this._clock.nowUs();
                    this._onPhase?.(
                        'first-byte',
                        context.firstStdoutUs - launchBeginUs,
                        manifest.id);
                    this._emit(
                        'first-stdout-byte',
                        manifest.id,
                        runId,
                        context.firstStdoutUs);
                },
                onEof: () => this._emit(
                    'stdout-eof', manifest.id, runId, this._clock.nowUs()),
            });
        const stderrPromise = drainBounded(
            process.get_stderr_pipe(),
            MAX_STDERR_BYTES,
            cancellable,
            () => this._terminate(
                context,
                'stderr-limit',
                `Plugin ${manifest.id} exceeded ${MAX_STDERR_BYTES} stderr bytes`),
            {
                onEof: () => this._emit(
                    'stderr-eof', manifest.id, runId, this._clock.nowUs()),
            });
        const waitPromise = waitForProcess(process).finally(() => {
            context.exited = true;
            context.processExitUs = this._clock.nowUs();
            this._emit('process-exit', manifest.id, runId, context.processExitUs);
            if (context.forceSourceId !== 0) {
                GLib.source_remove(context.forceSourceId);
                context.forceSourceId = 0;
            }
            if (context.failure !== null)
                cancellable.cancel();
        });

        let stdoutResult;
        let stderrResult;
        try {
            [stdoutResult, stderrResult] = await Promise.all([
                stdoutPromise,
                stderrPromise,
                waitPromise,
            ]);
        } finally {
            if (context.timeoutSourceId !== 0)
                GLib.source_remove(context.timeoutSourceId);
            if (context.forceSourceId !== 0)
                GLib.source_remove(context.forceSourceId);
            if (this._active.get(manifest.id)?.generation === generation)
                this._active.delete(manifest.id);
        }

        const stderr = decodeLossy(stderrResult.chunks);
        const details = {
            runId,
            launchBeginUs,
            spawnReturnUs,
            firstStdoutUs: context.firstStdoutUs,
            processExitUs: context.processExitUs,
            stdoutBytes: stdoutResult.bytes,
            stderrBytes: stderrResult.bytes,
        };
        this._onPhase?.('child-wall', context.processExitUs - launchBeginUs, manifest.id);
        this._onPhase?.(
            'pipe-drain',
            this._clock.nowUs() - context.processExitUs,
            manifest.id);
        if (context.failure !== null)
            throw new OneShotRunError(
                context.failure.kind, context.failure.message, stderr, details);
        if (!process.get_if_exited()) {
            throw new OneShotRunError(
                'signal',
                `Plugin ${manifest.id} exited after signal ${process.get_term_sig()}`,
                stderr,
                details);
        }
        const exitStatus = process.get_exit_status();
        if (exitStatus !== 0) {
            throw new OneShotRunError(
                'nonzero-exit',
                `Plugin ${manifest.id} exited with status ${exitStatus}`,
                stderr,
                details);
        }

        let raw;
        const decodeBeginUs = this._clock.nowUs();
        this._emit('decode-begin', manifest.id, runId, decodeBeginUs);
        try {
            raw = new TextDecoder('utf-8', {fatal: true}).decode(joinChunks(stdoutResult.chunks));
        } catch (error) {
            const decodeEndUs = this._clock.nowUs();
            this._emit('decode-end', manifest.id, runId, decodeEndUs);
            this._onPhase?.('decode', decodeEndUs - decodeBeginUs, manifest.id);
            throw new OneShotRunError(
                'utf8',
                `Plugin ${manifest.id} stdout is not valid UTF-8: ${error.message}`,
                stderr,
                details);
        }
        const decodeEndUs = this._clock.nowUs();
        this._emit('decode-end', manifest.id, runId, decodeEndUs);
        this._onPhase?.('decode', decodeEndUs - decodeBeginUs, manifest.id);
        return Object.freeze({
            raw,
            stderr,
            stdoutBytes: stdoutResult.bytes,
            niceApplied: manifest.nice === null || this._nicePath !== null,
            details: Object.freeze(details),
        });
    }

    /** Terminates one plugin's active direct child, if present. */
    cancel(pluginId) {
        const context = this._active.get(pluginId);
        if (context !== undefined)
            this._terminate(context, 'cancelled', `Plugin ${pluginId} was cancelled`);
    }

    /** Terminates all active direct children and prevents stale lookup entries. */
    cancelAll() {
        for (const [pluginId, context] of this._active)
            this._terminate(context, 'cancelled', `Plugin ${pluginId} was cancelled`);
    }

    _buildArgv(manifest) {
        if (manifest.nice === null || this._nicePath === null)
            return manifest.command;
        return [this._nicePath, '-n', String(manifest.nice), ...manifest.command];
    }

    _terminate(context, kind, message) {
        if (context.failure !== null)
            return;
        context.failure = {kind, message};
        if (context.exited) {
            context.cancellable.cancel();
            return;
        }
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

    _emit(kind, pluginId, runId, timestampUs, extra = {}) {
        this._onEvent?.({kind, pluginId, runId, timestampUs, ...extra});
    }
}

function drainBounded(
    stream,
    maximumBytes,
    cancellable,
    onOverflow,
    {onFirstByte = null, onEof = null} = {}) {
    const chunks = [];
    let bytes = 0;
    return new Promise((resolve, reject) => {
        const read = () => {
            const requestBytes = bytes === maximumBytes ? 1 :
                Math.min(READ_BYTES, maximumBytes - bytes);
            stream.read_bytes_async(
                requestBytes,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (source, result) => {
                    let chunk;
                    try {
                        const bytes = source.read_bytes_finish(result);
                        chunk = new Uint8Array(bytes.get_data());
                    } catch (error) {
                        if (cancellable.is_cancelled()) {
                            resolve({chunks, bytes});
                            return;
                        }
                        reject(error);
                        return;
                    }
                    if (chunk.length === 0) {
                        onEof?.();
                        resolve({chunks, bytes});
                        return;
                    }
                    if (bytes === 0)
                        onFirstByte?.();
                    if (bytes === maximumBytes) {
                        onOverflow();
                        read();
                        return;
                    }
                    chunks.push(chunk);
                    bytes += chunk.length;
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

function joinChunks(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return joined;
}

function decodeLossy(chunks) {
    return new TextDecoder().decode(joinChunks(chunks));
}
