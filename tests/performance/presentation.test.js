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
    summary.framePacing.cadenceSource !== 'presentation-feedback' ||
    summary.framePacing.delayedIntervals.count !== 1 ||
    summary.framePacing.multiRefreshGaps.count !== 0 ||
    summary.framePacing.freezeLikePauses.detected ||
    summary.framePacing.experienceClass !==
        'misses-without-freeze-like-pauses' ||
    summary.uiApplyCorrelation.intervalsWithUiApply !== 2 ||
    summary.uiApplyCorrelation.longIntervalsWithUiApply !== 1 ||
    summary.intervalNanoseconds.maximum !== 20_000_000) {
    throw new Error(`Unexpected presentation summary: ${JSON.stringify(summary)}`);
}

// VRR presentation feedback reports refresh=0. A continuous probe can still
// distinguish ordinary missed refreshes from a freeze-like presentation gap
// using its observed fastest cadence. This is descriptive, not a refresh gate.
const vrrEvents = [{type: 'environment', presentationClockId: 1}];
timestamp = start;
for (let index = 0; index < 20; index++) {
    if (index === 14)
        timestamp += 60_000_000;
    else if (index !== 0)
        timestamp += interval;
    vrrEvents.push({
        type: 'presented',
        submission: index + 1,
        submittedMonotonicNanoseconds: timestamp - 2_000_000,
        receivedMonotonicNanoseconds: timestamp + 100_000,
        presentationSeconds: Math.floor(timestamp / 1_000_000_000),
        presentationNanoseconds: timestamp % 1_000_000_000,
        refreshNanoseconds: 0,
        sequenceHigh: 0,
        sequenceLow: index + 1,
        flags: 1,
    });
}
const vrrSummary = summarizePresentation(vrrEvents);
if (vrrSummary.longIntervals.count !== 0 ||
    vrrSummary.framePacing.cadenceSource !== 'observed-fastest-decile' ||
    !vrrSummary.framePacing.cadenceIsInferred ||
    vrrSummary.framePacing.freezeLikePauses.count !== 1 ||
    vrrSummary.framePacing.freezeLikePauses.longestNanoseconds !== 60_000_000 ||
    vrrSummary.framePacing.maximumGapRefreshPeriods < 7 ||
    vrrSummary.framePacing.experienceClass !== 'freeze-like-pauses-detected') {
    throw new Error(`Unexpected VRR pacing summary: ${JSON.stringify(vrrSummary)}`);
}

const baselines = Array.from({length: 5}, (_value, index) => ({
    deliveredFramesPerSecond: 120 + index * 0.01,
    longIntervals: {perTenThousand: index},
}));
const scenarios = baselines.map((run, index) => ({
    deliveredFramesPerSecond: run.deliveredFramesPerSecond * (1 - 0.0005 + index * 0.00001),
    longIntervals: {perTenThousand: index + 0.5},
}));
const comparison = comparePresentationRuns(baselines, scenarios, 0.1, 1);
if (comparison.pairedRuns !== 5 || !comparison.frameRateGate.passed ||
    comparison.practicalEffect.decision !== 'no-material-effect' ||
    !comparison.practicalEffect.conclusive ||
    Math.abs(comparison.meanChangePercent + 0.048) > 0.001) {
    throw new Error(`Unexpected paired comparison: ${JSON.stringify(comparison)}`);
}

const regressionScenarios = baselines.map(run => ({
    deliveredFramesPerSecond: run.deliveredFramesPerSecond * 0.98,
    longIntervals: run.longIntervals,
}));
const regression = comparePresentationRuns(
    baselines, regressionScenarios, 0.1, 1);
if (regression.practicalEffect.decision !== 'material-regression' ||
    !regression.practicalEffect.conclusive) {
    throw new Error(`Material regression was not classified: ${JSON.stringify(regression)}`);
}

const noisyChanges = [-0.02, 0.02, -0.02, 0.02, 0];
const noisyScenarios = baselines.map((run, index) => ({
    deliveredFramesPerSecond:
        run.deliveredFramesPerSecond * (1 + noisyChanges[index]),
    longIntervals: run.longIntervals,
}));
const inconclusive = comparePresentationRuns(
    baselines, noisyScenarios, 0.1, 1);
if (inconclusive.practicalEffect.decision !== 'inconclusive' ||
    inconclusive.practicalEffect.conclusive) {
    throw new Error(`Noisy result was forced to a decision: ${JSON.stringify(inconclusive)}`);
}

print('ok - presentation feedback is summarized and compared in paired runs');
