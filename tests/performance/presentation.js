// SPDX-License-Identifier: GPL-3.0-or-later

const UI_APPLY_END = 1;
const DELAYED_REFRESH_MULTIPLIER = 1.5;
const MULTI_REFRESH_GAP_MULTIPLIER = 2.5;
const FREEZE_LIKE_GAP_NANOSECONDS = 50_000_000;

/** Summarizes continuous wp_presentation feedback without inventing FPS samples. */
export function summarizePresentation(events, coreTrace = null) {
    if (!Array.isArray(events) || events.length === 0)
        throw new Error('Presentation capture is empty');
    const environment = events.find(event => event.type === 'environment');
    if (!Number.isInteger(environment?.presentationClockId))
        throw new Error('Presentation capture has no clock environment record');

    const presented = events.filter(event => event.type === 'presented');
    const discarded = events.filter(event => event.type === 'discarded').length;
    if (presented.length < 2)
        throw new Error('Presentation capture needs at least two presented frames');

    const intervals = [];
    const longFlags = [];
    const presentationTimes = [];
    const callbackLatencies = [];
    const submissionLatencies = [];
    const refreshCounts = new Map();
    let previous = null;
    for (const event of presented) {
        validatePresented(event);
        const timestamp = BigInt(event.presentationSeconds) * 1_000_000_000n +
            BigInt(event.presentationNanoseconds);
        presentationTimes.push(timestamp);
        callbackLatencies.push(
            event.receivedMonotonicNanoseconds - event.submittedMonotonicNanoseconds);
        if (environment.presentationClockId === 1 && timestamp <= BigInt(Number.MAX_SAFE_INTEGER)) {
            submissionLatencies.push(
                Number(timestamp) - event.submittedMonotonicNanoseconds);
        }
        if (event.refreshNanoseconds > 0) {
            refreshCounts.set(
                event.refreshNanoseconds,
                (refreshCounts.get(event.refreshNanoseconds) ?? 0) + 1);
        }
        if (previous !== null) {
            const interval = Number(timestamp - previous.timestamp);
            if (!(interval > 0) || !Number.isSafeInteger(interval))
                throw new Error('Presentation timestamps are not strictly monotonic');
            intervals.push(interval);
            const refresh = event.refreshNanoseconds || previous.refreshNanoseconds;
            longFlags.push(refresh > 0 && interval > 1.5 * refresh);
        }
        previous = {timestamp, refreshNanoseconds: event.refreshNanoseconds};
    }

    const durationNanoseconds = Number(
        presentationTimes.at(-1) - presentationTimes[0]);
    const longIntervals = longFlags.filter(Boolean).length;
    const clusters = summarizeClusters(longFlags);
    const framePacing = summarizeFramePacing(
        intervals,
        refreshCounts,
        durationNanoseconds);
    const correlation = correlateUiApplies(
        presentationTimes,
        longFlags,
        coreTrace,
        environment.presentationClockId);
    return {
        formatVersion: 1,
        project: 'pico-argos',
        presentationClockId: environment.presentationClockId,
        submittedFrames: presented.length + discarded,
        presentedFrames: presented.length,
        discardedFrames: discarded,
        durationNanoseconds,
        deliveredFramesPerSecond:
            (presented.length - 1) * 1_000_000_000 / durationNanoseconds,
        intervalNanoseconds: summarizeNumbers(intervals),
        callbackLatencyNanoseconds: summarizeNumbers(callbackLatencies),
        submissionToPresentationNanoseconds: summarizeNumbers(submissionLatencies),
        refreshPeriods: [...refreshCounts]
            .sort((left, right) => left[0] - right[0])
            .map(([nanoseconds, count]) => ({nanoseconds, count})),
        framePacing,
        longIntervals: {
            thresholdRefreshMultiplier: 1.5,
            count: longIntervals,
            perTenThousand: 10_000 * longIntervals / intervals.length,
            clusterCount: clusters.count,
            maximumClusterLength: clusters.maximum,
        },
        uiApplyCorrelation: correlation,
    };
}

/**
 * Describes user-visible pacing separately from the strict delivered-FPS gate.
 *
 * A continuously committing probe normally runs at the fastest active cadence.
 * On VRR outputs presentation-time reports refresh=0, so the fastest decile of
 * observed intervals is used as a descriptive cadence estimate. That estimate
 * must not be promoted to an authoritative refresh-period acceptance gate.
 */
function summarizeFramePacing(intervals, refreshCounts, durationNanoseconds) {
    const cadence = selectNominalCadence(intervals, refreshCounts);
    const delayedFlags = intervals.map(
        value => value > DELAYED_REFRESH_MULTIPLIER * cadence.nanoseconds);
    const multiRefreshFlags = intervals.map(
        value => value > MULTI_REFRESH_GAP_MULTIPLIER * cadence.nanoseconds);
    const freezeLikeFlags = intervals.map(
        value => value >= FREEZE_LIKE_GAP_NANOSECONDS);
    const delayedClusters = summarizeClusters(delayedFlags);
    const delayedCount = delayedFlags.filter(Boolean).length;
    const multiRefreshCount = multiRefreshFlags.filter(Boolean).length;
    const freezeLikeCount = freezeLikeFlags.filter(Boolean).length;
    const maximumGap = intervals.reduce(
        (maximum, value) => Math.max(maximum, value), 0);
    const freezeLikeGaps = intervals.filter(
        value => value >= FREEZE_LIKE_GAP_NANOSECONDS);
    const estimatedMissedRefreshes = intervals.reduce((total, value) => {
        if (value <= DELAYED_REFRESH_MULTIPLIER * cadence.nanoseconds)
            return total;
        return total + Math.max(1, Math.round(value / cadence.nanoseconds) - 1);
    }, 0);

    let experienceClass = 'steady-cadence';
    if (freezeLikeCount !== 0)
        experienceClass = 'freeze-like-pauses-detected';
    else if (delayedCount !== 0)
        experienceClass = 'misses-without-freeze-like-pauses';

    return {
        cadenceSource: cadence.source,
        nominalIntervalNanoseconds: cadence.nanoseconds,
        nominalFramesPerSecond: 1_000_000_000 / cadence.nanoseconds,
        cadenceIsInferred: cadence.inferred,
        delayedRefreshThresholdMultiplier: DELAYED_REFRESH_MULTIPLIER,
        delayedIntervals: {
            count: delayedCount,
            perTenThousand: 10_000 * delayedCount / intervals.length,
            clusterCount: delayedClusters.count,
            maximumClusterLength: delayedClusters.maximum,
        },
        multiRefreshGapThresholdMultiplier: MULTI_REFRESH_GAP_MULTIPLIER,
        multiRefreshGaps: {
            count: multiRefreshCount,
            perTenThousand: 10_000 * multiRefreshCount / intervals.length,
        },
        estimatedMissedRefreshes,
        freezeLikePauses: {
            thresholdNanoseconds: FREEZE_LIKE_GAP_NANOSECONDS,
            detected: freezeLikeCount !== 0,
            count: freezeLikeCount,
            perMinute: durationNanoseconds > 0
                ? 60_000_000_000 * freezeLikeCount / durationNanoseconds
                : null,
            longestNanoseconds: freezeLikeGaps.length === 0
                ? null
                : freezeLikeGaps.reduce(
                    (maximum, value) => Math.max(maximum, value), 0),
        },
        maximumGapNanoseconds: maximumGap,
        maximumGapRefreshPeriods: maximumGap / cadence.nanoseconds,
        experienceClass,
    };
}

function selectNominalCadence(intervals, refreshCounts) {
    if (refreshCounts.size !== 0) {
        const [nanoseconds] = [...refreshCounts]
            .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
        return {source: 'presentation-feedback', nanoseconds, inferred: false};
    }

    const ordered = [...intervals].sort((left, right) => left - right);
    return {
        source: 'observed-fastest-decile',
        nanoseconds: percentile(ordered, 0.10),
        inferred: true,
    };
}

/** Compares paired, interleaved baseline/scenario presentation summaries. */
export function comparePresentationRuns(
    baselines,
    scenarios,
    limitPercent = 0.1,
    practicalMarginPercent = null) {
    if (!Array.isArray(baselines) || !Array.isArray(scenarios) ||
        baselines.length !== scenarios.length || baselines.length < 5) {
        throw new Error('Presentation comparison requires at least five paired runs');
    }
    const changes = baselines.map((baseline, index) => {
        const baselineFps = baseline.deliveredFramesPerSecond;
        const scenarioFps = scenarios[index].deliveredFramesPerSecond;
        if (!(baselineFps > 0) || !(scenarioFps > 0))
            throw new Error(`Run pair ${index + 1} has invalid delivered FPS`);
        return 100 * (scenarioFps - baselineFps) / baselineFps;
    });
    const meanChangePercent = mean(changes);
    const confidence = confidence95(changes);
    const baselineFps = baselines.map(run => run.deliveredFramesPerSecond);
    const scenarioFps = scenarios.map(run => run.deliveredFramesPerSecond);
    const baselineLong = baselines.map(run => run.longIntervals.perTenThousand);
    const scenarioLong = scenarios.map(run => run.longIntervals.perTenThousand);
    const practicalEffect = practicalMarginPercent === null
        ? null
        : classifyPracticalEffect(confidence, practicalMarginPercent);
    return {
        formatVersion: 1,
        project: 'pico-argos',
        pairedRuns: changes.length,
        baselineMeanFramesPerSecond: mean(baselineFps),
        scenarioMeanFramesPerSecond: mean(scenarioFps),
        pairedFrameRateChangesPercent: changes,
        meanChangePercent,
        confidence95Percent: confidence,
        confidenceIncludesZero: confidence.low <= 0 && confidence.high >= 0,
        meanLongIntervalsPerTenThousand: {
            baseline: mean(baselineLong),
            scenario: mean(scenarioLong),
        },
        frameRateGate: {
            maximumAbsoluteMeanChangePercent: limitPercent,
            passed: Math.abs(meanChangePercent) <= limitPercent,
        },
        practicalEffect,
    };
}

function classifyPracticalEffect(confidence, marginPercent) {
    if (!(marginPercent > 0) || !Number.isFinite(marginPercent))
        throw new Error('Practical effect margin must be a positive number');

    let decision = 'inconclusive';
    if (confidence.high < -marginPercent)
        decision = 'material-regression';
    else if (confidence.low > marginPercent)
        decision = 'material-improvement';
    else if (confidence.low >= -marginPercent &&
        confidence.high <= marginPercent)
        decision = 'no-material-effect';

    return {
        marginPercent,
        decision,
        conclusive: decision !== 'inconclusive',
    };
}

function validatePresented(event) {
    for (const name of [
        'presentationSeconds',
        'presentationNanoseconds',
        'refreshNanoseconds',
        'submittedMonotonicNanoseconds',
        'receivedMonotonicNanoseconds',
    ]) {
        if (!Number.isSafeInteger(event[name]) || event[name] < 0)
            throw new Error(`Invalid presentation field: ${name}`);
    }
    if (event.presentationNanoseconds >= 1_000_000_000 ||
        event.receivedMonotonicNanoseconds < event.submittedMonotonicNanoseconds) {
        throw new Error('Presentation feedback contains an invalid timestamp');
    }
}

function correlateUiApplies(times, longFlags, coreTrace, clockId) {
    if (coreTrace === null)
        return null;
    if (clockId !== 1) {
        return {
            available: false,
            reason: 'Presentation clock is not CLOCK_MONOTONIC',
        };
    }
    if (!Array.isArray(coreTrace.events) || coreTrace.trace?.dropped !== 0)
        throw new Error('Core trace is invalid or overflowed');
    const applies = coreTrace.events
        .filter(event => event[0] === UI_APPLY_END)
        .map(event => BigInt(event[1]) * 1_000n)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    let applyIndex = 0;
    let intervalsWithUiApply = 0;
    let longIntervalsWithUiApply = 0;
    for (let index = 1; index < times.length; index++) {
        while (applyIndex < applies.length && applies[applyIndex] <= times[index - 1])
            applyIndex++;
        let correlated = false;
        while (applyIndex < applies.length && applies[applyIndex] <= times[index]) {
            correlated = true;
            applyIndex++;
        }
        if (correlated) {
            intervalsWithUiApply++;
            if (longFlags[index - 1])
                longIntervalsWithUiApply++;
        }
    }
    return {
        available: true,
        uiApplyEvents: applies.length,
        intervalsWithUiApply,
        longIntervalsWithUiApply,
    };
}

function summarizeNumbers(values) {
    if (values.length === 0) {
        return {count: 0, mean: null, p50: null, p95: null, p99: null, maximum: null};
    }
    const ordered = [...values].sort((left, right) => left - right);
    return {
        count: ordered.length,
        mean: mean(ordered),
        p50: percentile(ordered, 0.50),
        p95: percentile(ordered, 0.95),
        p99: percentile(ordered, 0.99),
        maximum: ordered.at(-1),
    };
}

function summarizeClusters(flags) {
    let count = 0;
    let current = 0;
    let maximum = 0;
    for (const value of flags) {
        if (value) {
            current++;
            if (current === 1)
                count++;
            maximum = Math.max(maximum, current);
        } else {
            current = 0;
        }
    }
    return {count, maximum};
}

function confidence95(values) {
    const average = mean(values);
    const variance = values.reduce(
        (sum, value) => sum + (value - average) ** 2,
        0) / (values.length - 1);
    const critical = studentCritical95(values.length - 1);
    const margin = critical * Math.sqrt(variance / values.length);
    return {low: average - margin, high: average + margin, margin};
}

function studentCritical95(degreesOfFreedom) {
    const values = [
        12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306,
        2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120,
        2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064,
        2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
    ];
    return degreesOfFreedom <= values.length
        ? values[degreesOfFreedom - 1]
        : 1.96;
}

function percentile(ordered, fraction) {
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
