// SPDX-License-Identifier: GPL-3.0-or-later

const EVENTS = Object.freeze({
    UI_APPLY_END: 1,
    STAGE_PRESENTED: 5,
    LAUNCH_BEGIN: 8,
    SNAPSHOT_ACCEPTED: 27,
    SNAPSHOT_SEQUENCE: 28,
});

/** Joins one system-plugin timing ring to one core trace by run and sequence. */
export function analyzeCorrelation(system, core) {
    validateDocument(system, 'system timing');
    validateDocument(core, 'core');
    if (system.dropped !== 0 || core.trace?.dropped !== 0)
        throw new Error('A timing ring overflowed; the capture is not admissible');

    const pluginId = tracePluginId('system-monitor');
    const launches = core.events.filter(event =>
        event[0] === EVENTS.LAUNCH_BEGIN && event[3] === pluginId);
    if (launches.length === 0)
        throw new Error('Core trace has no system-monitor launch for correlation');
    const launch = launches.reduce((nearest, candidate) =>
        Math.abs(candidate[1] - system.startedMonotonicUs) <
            Math.abs(nearest[1] - system.startedMonotonicUs)
            ? candidate
            : nearest);
    const runId = launch[2];

    const runByCycle = new Map(core.events
        .filter(event => event[0] === EVENTS.SNAPSHOT_ACCEPTED)
        .map(event => [event[2], event[3]]));
    const cycleBySequence = new Map(core.events
        .filter(event => event[0] === EVENTS.SNAPSHOT_SEQUENCE &&
            runByCycle.get(event[2]) === runId)
        .map(event => [event[3], event[2]]));
    const applyByCycle = new Map(core.events
        .filter(event => event[0] === EVENTS.UI_APPLY_END)
        .map(event => [event[2], event[1]]));
    const presentedByCycle = new Map();
    for (const event of core.events.filter(value =>
        value[0] === EVENTS.STAGE_PRESENTED)) {
        const previous = presentedByCycle.get(event[2]);
        if (previous === undefined || event[1] < previous)
            presentedByCycle.set(event[2], event[1]);
    }

    const samples = [];
    for (const event of system.events) {
        const sequence = event[7];
        if (sequence === 0)
            continue;
        const cycleId = cycleBySequence.get(sequence);
        const applyEndUs = applyByCycle.get(cycleId);
        if (cycleId === undefined || applyEndUs === undefined)
            continue;
        const stagePresentedUs = presentedByCycle.get(cycleId) ?? 0;
        samples.push({
            sequence,
            cycleId,
            scheduledDeadlineUs: event[0],
            sampleBeginUs: event[1],
            sampleEndUs: event[2],
            formatBeginUs: event[3],
            formatEndUs: event[4],
            writeBeginUs: event[5],
            writeEndUs: event[6],
            applyEndUs,
            stagePresentedUs,
            samplingDelayUs: event[1] - event[0],
            samplingUs: event[2] - event[1],
            formattingUs: event[4] - event[3],
            pipeToApplyUs: applyEndUs - event[6],
            deadlineToApplyUs: applyEndUs - event[0],
            applyToStagePresentedUs: stagePresentedUs === 0
                ? null
                : stagePresentedUs - applyEndUs,
        });
    }
    if (samples.length === 0)
        throw new Error('No changed system samples correlated through UI apply');
    for (const sample of samples) {
        for (const [name, value] of Object.entries(sample)) {
            if (name.endsWith('Us') && value !== null && value < 0)
                throw new Error(`Correlation produced negative ${name}`);
        }
    }

    const phases = {};
    for (const name of [
        'samplingDelayUs',
        'samplingUs',
        'formattingUs',
        'pipeToApplyUs',
        'deadlineToApplyUs',
        'applyToStagePresentedUs',
    ]) {
        phases[name] = summarize(samples
            .map(sample => sample[name])
            .filter(value => value !== null));
    }
    return {
        formatVersion: 1,
        project: 'pico-argos',
        runId,
        correlatedSamples: samples.length,
        firstSequence: samples[0].sequence,
        lastSequence: samples.at(-1).sequence,
        freshnessGate: {
            p95LimitUs: 350_000,
            maximumLimitUs: 750_000,
            passed: phases.deadlineToApplyUs.p95Us <= 350_000 &&
                phases.deadlineToApplyUs.maximumUs <= 750_000,
        },
        phases,
    };
}

function summarize(values) {
    if (values.length === 0) {
        return {
            count: 0,
            p50Us: null,
            p95Us: null,
            p99Us: null,
            maximumUs: null,
        };
    }
    const ordered = [...values].sort((left, right) => left - right);
    return {
        count: ordered.length,
        p50Us: percentile(ordered, 0.50),
        p95Us: percentile(ordered, 0.95),
        p99Us: percentile(ordered, 0.99),
        maximumUs: ordered.at(-1),
    };
}

function percentile(ordered, fraction) {
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function validateDocument(document, name) {
    if (document === null || typeof document !== 'object' ||
        !Array.isArray(document.events)) {
        throw new Error(`${name} trace is not a valid document`);
    }
}

function tracePluginId(pluginId) {
    let hash = 2_166_136_261;
    for (let index = 0; index < pluginId.length; index++) {
        hash ^= pluginId.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash;
}
