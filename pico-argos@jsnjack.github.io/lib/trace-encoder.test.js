// SPDX-License-Identifier: GPL-3.0-or-later

import {TraceEncoder} from './trace-encoder.js';
import {TraceRing, TRACE_EVENTS} from './trace.js';

const trace = new TraceRing(3);
trace.record(TRACE_EVENTS.UI_APPLY_END, 100, 1);
trace.record(TRACE_EVENTS.STAGE_BEFORE_PAINT, 110, 1, 1);
trace.record(TRACE_EVENTS.STAGE_PRESENTED, 120, 1, 1);

const clock = {
    timestampUs: 0,
    nowUs() {
        this.timestampUs += 300;
        return this.timestampUs;
    },
};
const encoder = new TraceEncoder({formatVersion: 1, traceId: 7}, trace);
const chunks = [];
for (;;) {
    const chunk = encoder.nextChunk(clock, 500, 40);
    if (chunk === null)
        break;
    chunks.push(chunk);
}

if (chunks.length < 4)
    throw new Error(`Expected incremental chunks, got ${chunks.length}`);

const document = JSON.parse(chunks.join(''));
if (document.traceId !== 7)
    throw new Error(`Unexpected trace ID: ${document.traceId}`);
if (JSON.stringify(document.events) !== JSON.stringify(trace.events()))
    throw new Error('Incremental trace events changed during encoding');

print('ok - trace JSON is serialized in bounded incremental chunks');
