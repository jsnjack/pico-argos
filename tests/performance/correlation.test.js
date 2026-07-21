// SPDX-License-Identifier: GPL-3.0-or-later

import {analyzeCorrelation} from './correlation.js';

const pluginId = 2_991_785_539;
const system = {
    startedMonotonicUs: 1_010,
    dropped: 0,
    events: [
        [1_000, 1_010, 1_020, 1_021, 1_022, 1_023, 1_024, 1],
        [2_000, 2_010, 2_020, 2_021, 2_022, 2_023, 2_024, 2],
        [3_000, 3_010, 3_020, 3_021, 3_022, 0, 0, 0],
    ],
};
const core = {
    trace: {dropped: 0},
    events: [
        [8, 1_000, 7, pluginId],
        [27, 1_030, 11, 7],
        [28, 1_031, 11, 1],
        [1, 1_050, 11, 0],
        [5, 1_060, 11, 1],
        [27, 2_030, 12, 7],
        [28, 2_031, 12, 2],
        [1, 2_060, 12, 0],
    ],
};
const analysis = analyzeCorrelation(system, core);
if (analysis.runId !== 7 || analysis.correlatedSamples !== 2 ||
    analysis.phases.deadlineToApplyUs.p95Us !== 60 ||
    analysis.phases.pipeToApplyUs.maximumUs !== 36 ||
    analysis.phases.applyToStagePresentedUs.count !== 1 ||
    !analysis.freshnessGate.passed) {
    throw new Error(`Unexpected correlation analysis: ${JSON.stringify(analysis)}`);
}
print('ok - system deadlines correlate through core UI apply and stage timing');
