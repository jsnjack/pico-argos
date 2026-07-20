// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {TRACE_EVENTS} from './trace.js';

const ARM_TIMEOUT_MS = 100;
const SIGNALS = Object.freeze([
    {
        name: 'before-update',
        eventId: TRACE_EVENTS.STAGE_BEFORE_UPDATE,
        mask: 1,
    },
    {
        name: 'before-paint',
        eventId: TRACE_EVENTS.STAGE_BEFORE_PAINT,
        mask: 2,
    },
    {
        name: 'after-paint',
        eventId: TRACE_EVENTS.STAGE_AFTER_PAINT,
        mask: 4,
    },
    {
        name: 'presented',
        eventId: TRACE_EVENTS.STAGE_PRESENTED,
        mask: 8,
    },
]);

/** Captures the first stage cycle after a traced visible mutation. */
export class StageTrace {
    constructor(stage, clock, diagnostics, dependencies = {}) {
        this._stage = stage;
        this._clock = clock;
        this._diagnostics = diagnostics;
        this._signalExists = dependencies.signalExists ?? (name =>
            GObject.signal_lookup(name, stage.constructor.$gtype) !== 0);
        this._scheduleTimeout = dependencies.scheduleTimeout ?? (callback =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARM_TIMEOUT_MS, callback));
        this._removeSource = dependencies.removeSource ?? (sourceId =>
            GLib.source_remove(sourceId));
        this._connections = [];
        this._timeoutId = 0;
        this._viewStates = new Map();
        this._fallbackState = {id: 0, mask: 0};
        this._cycleId = 0;
    }

    /** Arms feature-detected stage signals for one following cycle per view. */
    arm(cycleId) {
        if (!this._diagnostics.traceActive)
            return;

        this.disarm();
        this._cycleId = cycleId;
        this._prepareViews();

        for (const signal of SIGNALS) {
            if (!this._signalExists(signal.name))
                continue;

            const signalId = this._stage.connect(
                signal.name,
                (_stage, view) => this._recordSignal(signal, view));
            this._connections.push(signalId);
        }

        if (this._connections.length === 0)
            return;

        this._timeoutId = this._scheduleTimeout(() => {
            this._timeoutId = 0;
            this._disconnectSignals();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Disconnects all stage signals and removes the arm timeout. */
    disarm() {
        if (this._timeoutId !== 0) {
            this._removeSource(this._timeoutId);
            this._timeoutId = 0;
        }
        this._disconnectSignals();
    }

    /** Releases all trace hook resources. */
    destroy() {
        this.disarm();
        this._viewStates.clear();
        this._stage = null;
        this._clock = null;
        this._diagnostics = null;
    }

    _prepareViews() {
        this._viewStates.clear();
        this._fallbackState.mask = 0;

        const views = this._stage.peek_stage_views?.() ?? [];
        const count = Math.min(views.length, 255);
        for (let index = 0; index < count; index++)
            this._viewStates.set(views[index], {id: index + 1, mask: 0});
    }

    _recordSignal(signal, view) {
        const state = this._viewStates.get(view) ?? this._fallbackState;
        if ((state.mask & signal.mask) !== 0)
            return;

        state.mask |= signal.mask;
        this._diagnostics.recordTraceEvent(
            signal.eventId,
            this._clock.nowUs(),
            this._cycleId,
            state.id);
    }

    _disconnectSignals() {
        for (const signalId of this._connections)
            this._stage.disconnect(signalId);
        this._connections = [];
    }
}
