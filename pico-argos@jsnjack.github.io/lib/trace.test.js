// SPDX-License-Identifier: GPL-3.0-or-later

import {TraceRing, TRACE_EVENTS, tracePluginId} from './trace.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const cases = [
    ['plugin trace identifiers are stable and distinct', () => {
        assertEqual(tracePluginId('alpha'), tracePluginId('alpha'), 'stable plugin ID');
        if (tracePluginId('alpha') === tracePluginId('beta'))
            throw new Error('Fixture plugin trace IDs collided');
    }],
    ['trace slots retain numeric correlation fields', () => {
        const trace = new TraceRing(2);

        assertEqual(trace.record(TRACE_EVENTS.UI_APPLY_END, 100, 7), true, 'first record');
        assertEqual(trace.record(TRACE_EVENTS.STAGE_PRESENTED, 125, 7, 2), true, 'second record');
        assertEqual(trace.summary(), {
            capacity: 2,
            eventCount: 2,
            dropped: 0,
        }, 'trace summary');
        assertEqual(trace.events(), [
            [TRACE_EVENTS.UI_APPLY_END, 100, 7, 0],
            [TRACE_EVENTS.STAGE_PRESENTED, 125, 7, 2],
        ], 'trace events');
    }],
    ['overflow increments a counter without growing storage', () => {
        const trace = new TraceRing(1);
        trace.record(TRACE_EVENTS.UI_APPLY_END, 100, 1);

        assertEqual(trace.record(TRACE_EVENTS.STAGE_PRESENTED, 125, 1), false, 'overflow result');
        assertEqual(trace.summary(), {
            capacity: 1,
            eventCount: 1,
            dropped: 1,
        }, 'overflow summary');
        assertEqual(trace.events().length, 1, 'retained event count');
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
