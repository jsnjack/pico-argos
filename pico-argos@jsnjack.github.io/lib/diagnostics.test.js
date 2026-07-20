// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Diagnostics,
    DIAGNOSTICS_MODES,
    DurationHistogram,
} from './diagnostics.js';
import {TRACE_EVENTS} from './trace.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertThrows(callback, message) {
    try {
        callback();
    } catch (_error) {
        return;
    }

    throw new Error(`${message}: expected an exception`);
}

const cases = [
    ['duration summary uses fixed buckets', () => {
        const histogram = new DurationHistogram();
        histogram.observe(10);
        histogram.observe(11);
        histogram.observe(10_001);

        assertEqual(histogram.snapshot(), {
            count: 3,
            sumUs: 10_022,
            minimumUs: 10,
            maximumUs: 10_001,
            buckets: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        }, 'duration summary');
    }],
    ['reset retains a valid empty summary', () => {
        const histogram = new DurationHistogram();
        histogram.observe(50);
        histogram.reset();

        assertEqual(histogram.snapshot(), {
            count: 0,
            sumUs: 0,
            minimumUs: null,
            maximumUs: null,
            buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        }, 'empty summary');
    }],
    ['off mode performs no collection', () => {
        const diagnostics = new Diagnostics(DIAGNOSTICS_MODES.OFF);
        diagnostics.recordDuration('ui-apply', 50);
        diagnostics.recordMutation('label-text-writes');
        diagnostics.recordSpawnFailure();

        const snapshot = diagnostics.snapshot();
        assertEqual(snapshot.phases['ui-apply'].count, 0, 'phase count');
        assertEqual(snapshot.mutations['label-text-writes'], 0, 'mutation count');
        assertEqual(snapshot.failures.spawn, 0, 'failure count');
    }],
    ['unknown observations are rejected', () => {
        const diagnostics = new Diagnostics();

        assertThrows(() => diagnostics.recordDuration('unknown', 1), 'phase name');
        assertThrows(() => diagnostics.recordMutation('unknown'), 'mutation name');
        assertThrows(() => diagnostics.setMode('trace'), 'persistent mode');
    }],
    ['transient trace overlays the persistent mode', () => {
        const diagnostics = new Diagnostics(DIAGNOSTICS_MODES.OFF);
        const traceId = diagnostics.startTrace();
        diagnostics.recordTraceEvent(TRACE_EVENTS.UI_APPLY_END, 100, 1);

        assertEqual(diagnostics.snapshot().trace, {
            id: traceId,
            active: true,
            timing: {
                startedMonotonicUs: null,
                startedRealtimeUs: null,
                endedMonotonicUs: null,
                endedRealtimeUs: null,
            },
            capacity: 16_384,
            eventCount: 1,
            dropped: 0,
        }, 'active trace');
        assertEqual(diagnostics.stopTrace(), traceId, 'stopped trace ID');
        assertEqual(diagnostics.snapshot().trace.active, false, 'stopped trace state');
        assertEqual(diagnostics.stopTrace(), null, 'second stop');
    }],
];

for (const [name, test] of cases) {
    try {
        test();
        print(`ok - ${name}`);
    } catch (error) {
        printerr(`not ok - ${name}: ${error.message}`);
        throw error;
    }
}
