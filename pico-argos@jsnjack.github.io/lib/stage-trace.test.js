// SPDX-License-Identifier: GPL-3.0-or-later

import {StageTrace} from './stage-trace.js';
import {TRACE_EVENTS} from './trace.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

class FakeStage {
    constructor(views) {
        this._views = views;
        this._nextSignalId = 1;
        this._signals = new Map();
    }

    peek_stage_views() {
        return this._views;
    }

    connect(name, callback) {
        const signalId = this._nextSignalId++;
        this._signals.set(signalId, {name, callback});
        return signalId;
    }

    disconnect(signalId) {
        this._signals.delete(signalId);
    }

    emit(name, view) {
        for (const signal of this._signals.values()) {
            if (signal.name === name)
                signal.callback(this, view);
        }
    }
}

const firstView = {};
const secondView = {};
const stage = new FakeStage([firstView, secondView]);
const events = [];
const diagnostics = {
    traceActive: false,
    recordTraceEvent(...event) {
        events.push(event);
    },
};
const clock = {
    timestampUs: 100,
    nowUs() {
        return this.timestampUs++;
    },
};
let timeoutCallback = null;
const removedSources = [];
const trace = new StageTrace(stage, clock, diagnostics, {
    signalExists: name => name === 'before-update' || name === 'presented',
    scheduleTimeout: callback => {
        timeoutCallback = callback;
        return 42;
    },
    removeSource: sourceId => removedSources.push(sourceId),
});

trace.arm(7);
assertEqual(stage._signals.size, 0, 'inactive trace connections');

diagnostics.traceActive = true;
trace.arm(7);
stage.emit('before-update', firstView);
stage.emit('before-update', firstView);
stage.emit('presented', firstView);
stage.emit('before-update', secondView);

assertEqual(events, [
    [TRACE_EVENTS.STAGE_BEFORE_UPDATE, 100, 7, 1],
    [TRACE_EVENTS.STAGE_PRESENTED, 101, 7, 1],
    [TRACE_EVENTS.STAGE_BEFORE_UPDATE, 102, 7, 2],
], 'first stage cycle events');
assertEqual(stage._signals.size, 2, 'active trace connections');

timeoutCallback();
assertEqual(stage._signals.size, 0, 'timeout cleanup');

trace.arm(8);
trace.disarm();
assertEqual(removedSources, [42], 'explicit timeout removal');
assertEqual(stage._signals.size, 0, 'explicit signal cleanup');
print('ok - stage trace is mutation-armed, bounded, and cleaned up');
