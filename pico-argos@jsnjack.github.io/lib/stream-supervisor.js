// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {compareManifests} from './manifest.js';
import {StreamRestartPolicy} from './stream-framing.js';

/** Maximum number of simultaneous persistent stream children. */
export const MAX_STREAMS = 4;

/** Serializes stream starts and applies bounded restart/lockout policy. */
export class StreamSupervisor {
    constructor({clock, runner, timer = null, onMessage = null, onEvent = null}) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('StreamSupervisor requires a monotonic clock');
        if (typeof runner?.run !== 'function')
            throw new TypeError('StreamSupervisor requires a stream runner');
        this._clock = clock;
        this._runner = runner;
        this._timer = timer ?? new SupervisorTimer();
        this._onMessage = onMessage;
        this._onEvent = onEvent;
        this._states = new Map();
        this._launchSource = null;
        this._started = false;
    }

    /** Registers or replaces one discovered stream plugin. */
    setPlugin(plugin) {
        if (plugin.manifest.mode !== 'stream')
            throw new TypeError('StreamSupervisor accepts stream plugins only');
        const previous = this._states.get(plugin.id);
        if (previous === undefined) {
            this._states.set(plugin.id, {
                plugin,
                generation: 1,
                running: false,
                restartSource: null,
                policy: new StreamRestartPolicy(),
                locked: false,
                limitReported: false,
            });
        } else {
            previous.generation++;
            previous.plugin = plugin;
            previous.policy.reset();
            previous.locked = false;
            this._cancelRestart(previous);
            if (previous.running)
                this._runner.cancel(plugin.id);
        }
        this._scheduleLaunch();
    }

    /** Removes and terminates one stream plugin. */
    removePlugin(pluginId) {
        const state = this._states.get(pluginId);
        if (state === undefined)
            return;
        state.generation++;
        this._cancelRestart(state);
        this._states.delete(pluginId);
        if (state.running)
            this._runner.cancel(pluginId);
        this._scheduleLaunch();
    }

    /** Starts serialized launches for the first four ordered stream plugins. */
    start() {
        if (this._started)
            throw new Error('StreamSupervisor is already started');
        this._started = true;
        this._reportAdmissionLimits();
        this._scheduleLaunch();
    }

    /** Cancels sources and all direct stream children. */
    stop() {
        this._started = false;
        if (this._launchSource !== null) {
            this._timer.cancel(this._launchSource);
            this._launchSource = null;
        }
        for (const state of this._states.values()) {
            state.generation++;
            this._cancelRestart(state);
        }
        this._runner.cancelAll();
    }

    /** Clears a lockout and restarts one stream on explicit user request. */
    restart(pluginId) {
        const state = this._states.get(pluginId);
        if (state === undefined)
            return false;
        state.generation++;
        state.policy.reset();
        state.locked = false;
        this._cancelRestart(state);
        if (state.running)
            this._runner.cancel(pluginId);
        this._scheduleLaunch();
        return true;
    }

    /** Returns bounded health and concurrency state. */
    snapshot() {
        return {
            active: [...this._states.values()].filter(state => state.running).length,
            plugins: this._orderedStates().map(state => ({
                id: state.plugin.id,
                running: state.running,
                locked: state.locked,
                waitingToRestart: state.restartSource !== null,
                admitted: this._isAdmitted(state),
            })),
        };
    }

    _scheduleLaunch() {
        if (!this._started || this._launchSource !== null)
            return;
        this._reportAdmissionLimits();
        this._launchSource = this._timer.schedule(0, () => {
            this._launchSource = null;
            this._launchOne();
        });
    }

    _launchOne() {
        if (!this._started)
            return;
        const active = [...this._states.values()].filter(state => state.running).length;
        if (active >= MAX_STREAMS)
            return;
        const state = this._orderedStates().find(candidate =>
            this._isAdmitted(candidate) &&
            !candidate.running &&
            !candidate.locked &&
            candidate.restartSource === null);
        if (state === undefined)
            return;

        state.running = true;
        const generation = state.generation;
        const {plugin} = state;
        this._onEvent?.({kind: 'started', pluginId: plugin.id});
        this._runner.run(plugin.manifest, {
            workingDirectory: plugin.directory,
            onHealthy: nowUs => {
                if (this._isCurrent(state, generation)) {
                    state.policy.markHealthy(nowUs);
                    this._onEvent?.({kind: 'healthy', pluginId: plugin.id});
                }
            },
            onMessage: (raw, message) => {
                if (this._isCurrent(state, generation))
                    this._onMessage?.(plugin, raw, message);
            },
        }).catch(error => {
            if (this._isCurrent(state, generation) && error.kind !== 'cancelled')
                this._handleFailure(state, error);
        }).finally(() => {
            if (this._states.get(plugin.id) !== state)
                return;
            state.running = false;
            if (generation !== state.generation)
                this._scheduleLaunch();
            else if (state.restartSource === null && !state.locked)
                this._scheduleLaunch();
        });
        this._scheduleLaunch();
    }

    _handleFailure(state, error) {
        const restart = state.policy.fail(this._clock.nowUs());
        this._onEvent?.({
            kind: 'failure',
            pluginId: state.plugin.id,
            error,
            failures: restart.failures,
            restartDelayMs: restart.delayMs,
        });
        if (restart.locked) {
            state.locked = true;
            this._onEvent?.({kind: 'locked', pluginId: state.plugin.id});
            return;
        }
        state.restartSource = this._timer.schedule(restart.delayMs, () => {
            state.restartSource = null;
            if (this._started && this._states.get(state.plugin.id) === state)
                this._scheduleLaunch();
        });
    }

    _cancelRestart(state) {
        if (state.restartSource === null)
            return;
        this._timer.cancel(state.restartSource);
        state.restartSource = null;
    }

    _orderedStates() {
        return [...this._states.values()].sort((left, right) =>
            compareManifests(left.plugin.manifest, right.plugin.manifest));
    }

    _isAdmitted(state) {
        return this._orderedStates().slice(0, MAX_STREAMS).includes(state);
    }

    _isCurrent(state, generation) {
        return this._started &&
            this._states.get(state.plugin.id) === state &&
            state.generation === generation;
    }

    _reportAdmissionLimits() {
        const ordered = this._orderedStates();
        ordered.forEach((state, index) => {
            if (index < MAX_STREAMS) {
                state.limitReported = false;
            } else if (!state.limitReported) {
                state.limitReported = true;
                this._onEvent?.({
                    kind: 'limit',
                    pluginId: state.plugin.id,
                    message: `Persistent stream limit ${MAX_STREAMS} reached`,
                });
            }
        });
    }
}

class SupervisorTimer {
    schedule(delayMs, callback) {
        if (delayMs === 0) {
            return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            });
        }
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel(sourceId) {
        GLib.source_remove(sourceId);
    }
}
