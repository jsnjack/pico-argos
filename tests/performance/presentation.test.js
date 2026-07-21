// SPDX-License-Identifier: GPL-3.0-or-later

import {
    comparePresentationRuns,
    summarizePresentation,
} from './presentation.js';

const interval = 8_333_333;
const start = 1_000_000_000;
const events = [{type: 'environment', presentationClockId: 1}];
let timestamp = start;
for (let index = 0; index < 12; index++) {
    if (index === 7)
        timestamp += 20_000_000;
    else if (index !== 0)
        timestamp += interval;
    events.push({
        type: 'presented',
        submission: index + 1,
        submittedMonotonicNanoseconds: timestamp - 2_000_000,
        receivedMonotonicNanoseconds: timestamp + 100_000,
        presentationSeconds: Math.floor(timestamp / 1_000_000_000),
        presentationNanoseconds: timestamp % 1_000_000_000,
        refreshNanoseconds: interval,
        sequenceHigh: 0,
        sequenceLow: index + 1,
        flags: 1,
    });
}
events.push({
    type: 'discarded',
    submission: 13,
    submittedMonotonicNanoseconds: timestamp,
    receivedMonotonicNanoseconds: timestamp + 100_000,
});
const core = {
    trace: {dropped: 0},
    events: [
        [1, Math.floor((start + interval * 2) / 1_000), 1, 0],
        [1, Math.floor((start + interval * 6 + 10_000_000) / 1_000), 2, 0],
    ],
};
const summary = summarizePresentation(events, core);
if (summary.presentedFrames !== 12 || summary.discardedFrames !== 1 ||
    summary.longIntervals.count !== 1 ||
    summary.longIntervals.maximumClusterLength !== 1 ||
    summary.uiApplyCorrelation.intervalsWithUiApply !== 2 ||
    summary.uiApplyCorrelation.longIntervalsWithUiApply !== 1 ||
    summary.intervalNanoseconds.maximum !== 20_000_000) {
    throw new Error(`Unexpected presentation summary: ${JSON.stringify(summary)}`);
}

const baselines = Array.from({length: 5}, (_value, index) => ({
    deliveredFramesPerSecond: 120 + index * 0.01,
    longIntervals: {perTenThousand: index},
}));
const scenarios = baselines.map((run, index) => ({
    deliveredFramesPerSecond: run.deliveredFramesPerSecond * (1 - 0.0005 + index * 0.00001),
    longIntervals: {perTenThousand: index + 0.5},
}));
const comparison = comparePresentationRuns(baselines, scenarios);
if (comparison.pairedRuns !== 5 || !comparison.frameRateGate.passed ||
    Math.abs(comparison.meanChangePercent + 0.048) > 0.001) {
    throw new Error(`Unexpected paired comparison: ${JSON.stringify(comparison)}`);
}

print('ok - presentation feedback is summarized and compared in paired runs');
