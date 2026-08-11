// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {OneShotRunner} from './oneshot-runner.js';
import {OneShotScheduler} from './oneshot-scheduler.js';
import {StateStore} from './state.js';
import {StreamRunner} from './stream-runner.js';
import {StreamSupervisor} from './stream-supervisor.js';

const STALE_TICK_MS = 1_000;

/** Connects discovered plugins to bounded runtimes and semantic state. */
export class RuntimeManager {
    constructor({
        clock,
        stateStore = null,
        oneShotRunner = null,
        streamRunner = null,
        onChanges = null,
        onPluginAdded = null,
        onPluginChanged = null,
        onPluginRemoved = null,
        onHealth = null,
        onEvent = null,
        onPhase = null,
        nextCycleId = null,
    }) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('RuntimeManager requires a monotonic clock');
        this._clock = clock;
        this._state = stateStore ?? new StateStore();
        this._plugins = new Map();
        this._health = new Map();
        this._onChanges = onChanges;
        this._onPluginAdded = onPluginAdded;
        this._onPluginChanged = onPluginChanged;
        this._onPluginRemoved = onPluginRemoved;
        this._onHealth = onHealth;
        this._onEvent = onEvent;
        this._onPhase = onPhase;
        this._nextRunId = 0;
        this._localCycleId = 0;
        this._nextCycleId = nextCycleId ?? (() => ++this._localCycleId);
        this._currentChildren = 0;
        this._peakChildren = 0;
        const runnerOptions = {
            clock,
            onPhase,
            onEvent: event => this._handleRunnerEvent(event),
            nextRunId: () => ++this._nextRunId,
        };
        this._oneShotRunner = oneShotRunner ?? new OneShotRunner(runnerOptions);
        this._streamRunner = streamRunner ?? new StreamRunner(runnerOptions);
        this._oneShotScheduler = new OneShotScheduler({
            clock,
            run: (manifest, request) => this._runOneShot(manifest, request),
            onEvent: event => this._handleOneShotEvent(event),
            onPhase,
        });
        this._streamSupervisor = new StreamSupervisor({
            clock,
            runner: this._streamRunner,
            onMessage: (plugin, raw, context) =>
                this._acceptStream(plugin, raw, context),
            onEvent: event => this._handleStreamEvent(event),
        });
        this._staleSourceId = 0;
        this._started = false;
        this._generation = 0;
    }

    /** Registers or atomically reconfigures one discovered plugin. */
    setPlugin(plugin) {
        const previous = this._plugins.get(plugin.id) ?? null;
        if (previous !== null) {
            if (previous.manifest.mode === 'oneshot') {
                this._oneShotScheduler.removePlugin(plugin.id);
                this._oneShotRunner.cancel(plugin.id);
            } else {
                this._streamSupervisor.removePlugin(plugin.id);
            }
            this._state.invalidateRaw(plugin.id);
        }
        this._plugins.set(plugin.id, plugin);
        this._health.set(
            plugin.id,
            this._health.get(plugin.id) ?? createHealth(plugin, this._clock.nowUs()));
        const health = this._health.get(plugin.id);
        if (previous !== null) {
            health.processState = 'idle';
            health.runStartedUs = null;
            health.currentBackoffMs = null;
            health.lastHeartbeatUs = null;
            health.niceApplied = null;
        }
        health.mode = plugin.manifest.mode;
        health.niceRequested = plugin.manifest.nice;
        if (plugin.manifest.mode === 'oneshot')
            this._oneShotScheduler.setPlugin(plugin.manifest);
        else
            this._streamSupervisor.setPlugin(plugin);

        if (previous === null)
            this._onPluginAdded?.(plugin);
        else
            this._onPluginChanged?.(plugin, previous);
        this._updateStaleTimer();
        this._publishHealth(plugin.id);
    }

    /** Removes runtime work and semantic state for one plugin only. */
    removePlugin(pluginId) {
        const plugin = this._plugins.get(pluginId);
        if (plugin === undefined)
            return;
        if (plugin.manifest.mode === 'oneshot') {
            this._oneShotScheduler.removePlugin(pluginId);
            this._oneShotRunner.cancel(pluginId);
        } else {
            this._streamSupervisor.removePlugin(pluginId);
        }
        this._plugins.delete(pluginId);
        this._health.delete(pluginId);
        this._state.remove(pluginId);
        this._onPluginRemoved?.(plugin);
        this._updateStaleTimer();
    }

    /** Starts scheduling, supervision, and coarse staleness checks. */
    start() {
        if (this._started)
            throw new Error('RuntimeManager is already started');
        this._started = true;
        this._generation++;
        this._oneShotScheduler.start();
        this._streamSupervisor.start();
        this._updateStaleTimer();
    }

    /** Deterministically prevents work and terminates owned direct children. */
    stop() {
        this._started = false;
        this._generation++;
        if (this._staleSourceId !== 0) {
            GLib.source_remove(this._staleSourceId);
            this._staleSourceId = 0;
        }
        this._oneShotScheduler.stop();
        this._streamSupervisor.stop();
        this._oneShotRunner.cancelAll();
    }

    /** Stops owned work and clears every retained plugin and semantic model. */
    destroy() {
        this._started = false;
        this._generation++;
        if (this._staleSourceId !== 0) {
            GLib.source_remove(this._staleSourceId);
            this._staleSourceId = 0;
        }
        this._oneShotScheduler.destroy();
        this._streamSupervisor.destroy();
        this._oneShotRunner.cancelAll();
        this._state.clear();
        this._plugins.clear();
        this._health.clear();
        this._onChanges = null;
        this._onPluginAdded = null;
        this._onPluginChanged = null;
        this._onPluginRemoved = null;
        this._onHealth = null;
        this._onEvent = null;
        this._onPhase = null;
    }

    /** Requests the manifest-gated menu-open refresh for either runtime mode. */
    refreshOnOpen(pluginId) {
        const plugin = this._plugins.get(pluginId);
        if (plugin?.manifest.mode === 'oneshot')
            return this._oneShotScheduler.requestRefresh(pluginId);
        if (plugin?.manifest.mode === 'stream' &&
            plugin.manifest.protocolVersion === 2 &&
            plugin.manifest.refreshOnOpen)
            return this._streamSupervisor.menuOpened(pluginId);
        return false;
    }

    /** Requests one explicit user-initiated one-shot refresh. */
    refreshNow(pluginId) {
        return this._oneShotScheduler.requestManual(pluginId);
    }

    /** Explicitly clears a stream lockout and restarts its direct child. */
    restartStream(pluginId) {
        return this._streamSupervisor.restart(pluginId);
    }

    /** Activates one current, unselected protocol-v2 menu action. */
    activateMenuAction(pluginId, actionId) {
        const plugin = this._plugins.get(pluginId);
        if (plugin?.manifest.mode !== 'stream' ||
            plugin.manifest.protocolVersion !== 2)
            return false;
        const action = this._state.get(pluginId)?.menu.find(item =>
            item.id === actionId && item.kind === 'action');
        if (action === undefined || action.selected)
            return false;
        const accepted = this._streamSupervisor.activate(pluginId, actionId);
        if (accepted) {
            const health = this._health.get(pluginId);
            health.actions++;
            this._publishHealth(pluginId);
        }
        return accepted;
    }

    /** Applies only coarse visual staleness transitions. */
    tickStaleness() {
        const nowUs = this._clock.nowUs();
        for (const [pluginId, plugin] of this._plugins) {
            const health = this._health.get(pluginId);
            const maxStaleMs = plugin.manifest.maxStaleMs;
            if (maxStaleMs === null || health.lastSuccessUs === null)
                continue;
            const stale = nowUs - health.lastSuccessUs >= maxStaleMs * 1_000;
            const result = this._state.setStale(pluginId, stale);
            this._publishChanges(plugin, result);
        }
    }

    /** Returns sanitized bounded health for preferences and diagnostics. */
    snapshot() {
        const nowUs = this._clock.nowUs();
        return {
            children: {
                current: this._currentChildren,
                peak: this._peakChildren,
            },
            oneShot: this._oneShotScheduler.snapshot(),
            streams: this._streamSupervisor.snapshot(),
            plugins: [...this._health].map(([id, health]) => ({
                id,
                ...snapshotHealth(health, nowUs),
            })),
        };
    }

    async _runOneShot(manifest, request) {
        const plugin = this._plugins.get(manifest.id);
        const generation = this._generation;
        if (!this._started || plugin?.manifest !== manifest)
            return;
        const health = this._health.get(plugin.id);
        health.runs++;
        try {
            const result = await this._oneShotRunner.run(manifest, {
                menuOpen: request.menuOpen,
                workingDirectory: plugin.directory,
            });
            if (!this._isCurrent(plugin, generation))
                return;
            this._recordRunDetails(health, result.details);
            health.messages++;
            this._acceptSnapshot(plugin, result.raw, result.details?.runId ?? 0);
        } catch (error) {
            if (this._isCurrent(plugin, generation) && error.kind !== 'cancelled') {
                this._recordRunDetails(health, error.details);
                this._applyFailure(plugin, error);
            }
        }
    }

    _acceptStream(plugin, raw, context = {}) {
        if (this._plugins.get(plugin.id) !== plugin)
            return {kind: 'heartbeat'};
        const health = this._health.get(plugin.id);
        health.messages++;
        const startedUs = this._clock.nowUs();
        let processed;
        const observe = this._stateObserver(plugin, context, startedUs);
        try {
            processed = this._state.acceptProtocol(plugin.id, raw, {
                allowHeartbeat: true,
                allowActionResult: plugin.manifest.protocolVersion === 2,
                protocolVersion: plugin.manifest.protocolVersion ?? 1,
                validateSnapshot: snapshot => validateReservedText(plugin, snapshot),
                observe,
            });
        } finally {
            this._onPhase?.(
                'parse-validate-diff',
                this._clock.nowUs() - startedUs,
                plugin.id);
        }
        if (processed.message.kind === 'snapshot') {
            this._acceptProcessed(plugin, processed.state, context);
        } else if (processed.message.kind === 'heartbeat') {
            health.heartbeats++;
            health.lastHeartbeatUs = this._clock.nowUs();
            this._publishHealth(plugin.id);
        } else {
            if (processed.message.ok)
                health.actionSuccesses++;
            else
                health.actionFailures++;
            this._onEvent?.({
                runtime: 'state',
                kind: 'action-result',
                pluginId: plugin.id,
                runId: context.runId ?? 0,
                sequence: context.sequence ?? 0,
                requestId: processed.message.requestId,
                ok: processed.message.ok,
                timestampUs: this._clock.nowUs(),
            });
            this._publishHealth(plugin.id);
        }
        return processed.message;
    }

    _acceptSnapshot(plugin, raw, runId) {
        const startedUs = this._clock.nowUs();
        let processed;
        const context = {runId, sequence: 0};
        const observe = this._stateObserver(plugin, context, startedUs);
        try {
            processed = this._state.acceptProtocol(plugin.id, raw, {
                validateSnapshot: snapshot => validateReservedText(plugin, snapshot),
                observe,
            });
        } finally {
            this._onPhase?.(
                'parse-validate-diff',
                this._clock.nowUs() - startedUs,
                plugin.id);
        }
        this._acceptProcessed(plugin, processed.state, context);
    }

    _acceptProcessed(plugin, result, context = {}) {
        const health = this._health.get(plugin.id);
        const cycleId = this._nextCycleId();
        health.lastSuccessUs = this._clock.nowUs();
        health.lastFailure = null;
        health.lastCycleId = cycleId;
        health.accepted++;
        if (result.kind === 'raw-no-op')
            health.rawNoOps++;
        else if (result.kind === 'semantic-no-op')
            health.semanticNoOps++;
        this._onEvent?.({
            runtime: 'state',
            kind: 'snapshot-accepted',
            pluginId: plugin.id,
            cycleId,
            runId: context.runId ?? 0,
            sequence: context.sequence ?? 0,
            resultKind: result.kind,
            timestampUs: this._clock.nowUs(),
        });
        this._publishChanges(plugin, result, cycleId);
        this._publishHealth(plugin.id);
    }

    _applyFailure(plugin, error) {
        if (plugin === undefined)
            return;
        const health = this._health.get(plugin.id);
        const kind = failureKind(error);
        health.failures++;
        health.lastFailure = {
            kind,
            message: error.message ?? String(error),
            stderr: typeof error.stderr === 'string' ? error.stderr : '',
        };
        if (kind.includes('timeout'))
            health.timeouts++;
        if (isOutputRejection(kind))
            health.outputRejections++;
        const result = this._state.applyFailure(
            plugin.id,
            plugin.manifest.failurePolicy);
        this._publishChanges(plugin, result);
        this._publishHealth(plugin.id);
        this._onEvent?.({kind: 'failure', pluginId: plugin.id, error});
    }

    _handleOneShotEvent(event) {
        const health = this._health.get(event.pluginId);
        if (health !== undefined) {
            if (event.kind === 'started')
                health.processState = 'running';
            else if (event.kind === 'finished')
                health.processState = 'idle';
            else if (event.kind === 'skipped')
                health.skipped += event.count;
            this._publishHealth(event.pluginId);
        }
        this._onEvent?.({runtime: 'oneshot', ...event});
    }

    _handleRunnerEvent(event) {
        if (event.kind === 'spawn-return' && event.spawned) {
            this._currentChildren++;
            this._peakChildren = Math.max(this._peakChildren, this._currentChildren);
            const health = this._health.get(event.pluginId);
            if (health !== undefined)
                health.niceApplied = event.niceApplied;
        } else if (event.kind === 'process-exit') {
            this._currentChildren = Math.max(0, this._currentChildren - 1);
        } else if (event.kind === 'stdout-bytes') {
            const health = this._health.get(event.pluginId);
            if (health !== undefined)
                health.stdoutBytes += event.bytes;
        } else if (event.kind === 'stderr-bytes') {
            const health = this._health.get(event.pluginId);
            if (health !== undefined)
                health.stderrBytes += event.bytes;
        }
        this._onEvent?.({runtime: 'runner', ...event});
    }

    _handleStreamEvent(event) {
        const health = this._health.get(event.pluginId);
        if (health !== undefined) {
            if (event.kind === 'started') {
                health.processState = 'starting';
                health.runs++;
                health.runStartedUs = this._clock.nowUs();
                health.currentBackoffMs = null;
            } else if (event.kind === 'healthy')
                health.processState = 'running';
            else if (event.kind === 'failure') {
                health.processState = event.restartDelayMs === null ? 'locked' : 'backoff';
                health.restarts++;
                health.currentBackoffMs = event.restartDelayMs;
                this._recordRunDetails(health, event.error.details, false, false);
                this._applyFailure(this._plugins.get(event.pluginId), event.error);
            } else if (event.kind === 'locked') {
                health.processState = 'locked';
            } else if (event.kind === 'limit') {
                health.processState = 'rejected';
            }
            this._publishHealth(event.pluginId);
        }
        this._onEvent?.({runtime: 'stream', ...event});
    }

    _publishChanges(plugin, result, cycleId = 0) {
        if (result?.changes !== null && result?.changes !== undefined) {
            this._onChanges?.(
                plugin,
                result.changes,
                result.kind,
                this._state.getPresentation(plugin.id),
                cycleId);
        }
    }

    _publishHealth(pluginId) {
        const health = this._health.get(pluginId);
        if (health !== undefined)
            this._onHealth?.(pluginId, {...health});
    }

    _isCurrent(plugin, generation) {
        return this._started &&
            generation === this._generation &&
            this._plugins.get(plugin.id) === plugin;
    }

    _recordRunDetails(
        health, details, includeStdout = true, includeStderr = true) {
        if (details === null || details === undefined)
            return;
        if (includeStdout)
            health.stdoutBytes += details.stdoutBytes ?? 0;
        if (includeStderr)
            health.stderrBytes += details.stderrBytes ?? 0;
        if (Number.isFinite(details.launchBeginUs) &&
            Number.isFinite(details.processExitUs)) {
            health.lastChildRuntimeUs = details.processExitUs - details.launchBeginUs;
        }
    }

    _stateObserver(plugin, context, startedUs) {
        let parseBeginUs = null;
        let parseEndUs = null;
        let validateEndUs = null;
        return kind => {
            const nowUs = this._clock.nowUs();
            if (kind === 'raw-compare-end') {
                this._onPhase?.('raw-compare', nowUs - startedUs, plugin.id);
            } else if (kind === 'parse-begin') {
                parseBeginUs = nowUs;
            } else if (kind === 'parse-end') {
                parseEndUs = nowUs;
                this._onPhase?.('parse', nowUs - parseBeginUs, plugin.id);
            } else if (kind === 'validate-end') {
                validateEndUs = nowUs;
                this._onPhase?.('validate', nowUs - parseEndUs, plugin.id);
            } else if (kind === 'semantic-diff-end') {
                this._onPhase?.('semantic-diff', nowUs - validateEndUs, plugin.id);
            }
            this._onEvent?.({
                runtime: 'runner',
                kind,
                pluginId: plugin.id,
                runId: context.runId ?? 0,
                sequence: context.sequence ?? 0,
                timestampUs: nowUs,
            });
        };
    }

    _updateStaleTimer() {
        const needed = this._started && [...this._plugins.values()].some(plugin =>
            plugin.manifest.maxStaleMs !== null);
        if (!needed && this._staleSourceId !== 0) {
            GLib.source_remove(this._staleSourceId);
            this._staleSourceId = 0;
        } else if (needed && this._staleSourceId === 0) {
            this._staleSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                STALE_TICK_MS,
                () => {
                    this.tickStaleness();
                    return GLib.SOURCE_CONTINUE;
                });
        }
    }
}

function createHealth(plugin, nowUs) {
    return {
        mode: plugin.manifest.mode,
        processState: 'idle',
        measurementStartedUs: nowUs,
        runStartedUs: null,
        lastSuccessUs: null,
        lastCycleId: null,
        lastFailure: null,
        runs: 0,
        accepted: 0,
        rawNoOps: 0,
        semanticNoOps: 0,
        skipped: 0,
        failures: 0,
        restarts: 0,
        messages: 0,
        heartbeats: 0,
        actions: 0,
        actionSuccesses: 0,
        actionFailures: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        lastChildRuntimeUs: null,
        lastHeartbeatUs: null,
        currentBackoffMs: null,
        timeouts: 0,
        outputRejections: 0,
        niceApplied: null,
        niceRequested: plugin.manifest.nice,
    };
}

function snapshotHealth(health, nowUs) {
    const elapsedUs = Math.max(1, nowUs - health.measurementStartedUs);
    const noOps = health.rawNoOps + health.semanticNoOps;
    return {
        ...health,
        lastFailure: health.lastFailure === null
            ? null
            : {kind: health.lastFailure.kind},
        streamUptimeUs: health.mode === 'stream' &&
            ['starting', 'running'].includes(health.processState) &&
            health.runStartedUs !== null
            ? Math.max(0, nowUs - health.runStartedUs)
            : null,
        heartbeatAgeUs: health.lastHeartbeatUs === null
            ? null
            : Math.max(0, nowUs - health.lastHeartbeatUs),
        messageRatePerSecond: health.messages * 1_000_000 / elapsedUs,
        byteRatePerMinute: health.stdoutBytes * 60_000_000 / elapsedUs,
        noOpRate: health.accepted === 0 ? 0 : noOps / health.accepted,
    };
}

function failureKind(error) {
    if (typeof error?.kind === 'string')
        return error.kind;
    if (error?.name === 'ProtocolError')
        return 'protocol';
    return 'runtime';
}

function isOutputRejection(kind) {
    return [
        'stdout-limit',
        'stderr-limit',
        'line-limit',
        'byte-rate',
        'message-rate',
        'stderr-rate',
        'utf8',
        'partial-line',
        'stdout-read',
        'stderr-read',
        'protocol',
    ].includes(kind);
}

function validateReservedText(plugin, snapshot) {
    const reserve = plugin.manifest.reserveTextChars;
    if (reserve === 0 || snapshot.panel === null || snapshot.panel.text === null)
        return;
    if ([...snapshot.panel.text].length > reserve) {
        const error = new Error(
            `Plugin ${plugin.id} panel text exceeds reserveTextChars ${reserve}`);
        error.name = 'ProtocolError';
        error.kind = 'protocol';
        throw error;
    }
}
