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
        this._oneShotRunner = oneShotRunner ?? new OneShotRunner({clock});
        this._streamRunner = streamRunner ?? new StreamRunner({clock});
        this._oneShotScheduler = new OneShotScheduler({
            clock,
            run: (manifest, request) => this._runOneShot(manifest, request),
            onEvent: event => this._handleOneShotEvent(event),
        });
        this._streamSupervisor = new StreamSupervisor({
            clock,
            runner: this._streamRunner,
            onMessage: (plugin, raw) => this._acceptStream(plugin, raw),
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
        this._health.set(plugin.id, this._health.get(plugin.id) ?? createHealth(plugin));
        this._health.get(plugin.id).mode = plugin.manifest.mode;
        if (plugin.manifest.mode === 'oneshot')
            this._oneShotScheduler.setPlugin(plugin.manifest);
        else
            this._streamSupervisor.setPlugin(plugin);

        if (previous === null)
            this._onPluginAdded?.(plugin);
        else
            this._onPluginChanged?.(plugin, previous);
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
    }

    /** Starts scheduling, supervision, and coarse staleness checks. */
    start() {
        if (this._started)
            throw new Error('RuntimeManager is already started');
        this._started = true;
        this._generation++;
        this._oneShotScheduler.start();
        this._streamSupervisor.start();
        this._staleSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            STALE_TICK_MS,
            () => {
                this.tickStaleness();
                return GLib.SOURCE_CONTINUE;
            });
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

    /** Requests the manifest-gated one-shot menu-open refresh. */
    refreshOnOpen(pluginId) {
        return this._oneShotScheduler.requestRefresh(pluginId);
    }

    /** Explicitly clears a stream lockout and restarts its direct child. */
    restartStream(pluginId) {
        return this._streamSupervisor.restart(pluginId);
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
        return {
            oneShot: this._oneShotScheduler.snapshot(),
            streams: this._streamSupervisor.snapshot(),
            plugins: [...this._health].map(([id, health]) => ({id, ...health})),
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
            this._acceptSnapshot(plugin, result.raw);
        } catch (error) {
            if (this._isCurrent(plugin, generation) && error.kind !== 'cancelled')
                this._applyFailure(plugin, error);
        }
    }

    _acceptStream(plugin, raw) {
        if (this._plugins.get(plugin.id) !== plugin)
            return {kind: 'heartbeat'};
        const processed = this._state.acceptProtocol(plugin.id, raw, {
            allowHeartbeat: true,
            validateSnapshot: snapshot => validateReservedText(plugin, snapshot),
        });
        if (processed.message.kind === 'snapshot')
            this._acceptProcessed(plugin, processed.state);
        return processed.message;
    }

    _acceptSnapshot(plugin, raw) {
        const processed = this._state.acceptProtocol(plugin.id, raw, {
            validateSnapshot: snapshot => validateReservedText(plugin, snapshot),
        });
        this._acceptProcessed(plugin, processed.state);
    }

    _acceptProcessed(plugin, result) {
        const health = this._health.get(plugin.id);
        health.lastSuccessUs = this._clock.nowUs();
        health.lastFailure = null;
        health.accepted++;
        if (result.kind === 'raw-no-op')
            health.rawNoOps++;
        else if (result.kind === 'semantic-no-op')
            health.semanticNoOps++;
        this._publishChanges(plugin, result);
        this._publishHealth(plugin.id);
    }

    _applyFailure(plugin, error) {
        const health = this._health.get(plugin.id);
        health.failures++;
        health.lastFailure = {
            kind: error.kind ?? 'runtime',
            message: error.message ?? String(error),
        };
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

    _handleStreamEvent(event) {
        const health = this._health.get(event.pluginId);
        if (health !== undefined) {
            if (event.kind === 'started')
                health.processState = 'starting';
            else if (event.kind === 'healthy')
                health.processState = 'running';
            else if (event.kind === 'failure') {
                health.processState = event.restartDelayMs === null ? 'locked' : 'backoff';
                health.restarts++;
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

    _publishChanges(plugin, result) {
        if (result?.changes !== null && result?.changes !== undefined)
            this._onChanges?.(plugin, result.changes, result.kind);
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
}

function createHealth(plugin) {
    return {
        mode: plugin.manifest.mode,
        processState: 'idle',
        lastSuccessUs: null,
        lastFailure: null,
        runs: 0,
        accepted: 0,
        rawNoOps: 0,
        semanticNoOps: 0,
        skipped: 0,
        failures: 0,
        restarts: 0,
    };
}

function validateReservedText(plugin, snapshot) {
    const reserve = plugin.manifest.reserveTextChars;
    if (reserve === 0 || snapshot.panel?.text === null)
        return;
    if ([...snapshot.panel.text].length > reserve) {
        throw new Error(
            `Plugin ${plugin.id} panel text exceeds reserveTextChars ${reserve}`);
    }
}
