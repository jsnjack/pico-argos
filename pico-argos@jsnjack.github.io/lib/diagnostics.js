// SPDX-License-Identifier: GPL-3.0-or-later

import {TraceRing} from './trace.js';

/** Supported persistent diagnostic modes. */
export const DIAGNOSTICS_MODES = Object.freeze({
    OFF: 'off',
    SUMMARY: 'summary',
});

/** Fixed upper bounds for duration histogram buckets, in microseconds. */
export const DURATION_BUCKETS_US = Object.freeze([
    10,
    25,
    50,
    100,
    250,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    Number.POSITIVE_INFINITY,
]);

/** Phase names recorded by the performance harness. */
export const HARNESS_PHASES = Object.freeze([
    'child-wall',
    'decode',
    'get-summary',
    'menu-build',
    'parse-validate-diff',
    'pipe-drain',
    'scheduler-callback',
    'scheduler-lateness',
    'spawn-call',
    'trace-serialize',
    'ui-apply',
    'ui-queue-wait',
]);

/** Mutation names recorded by the performance harness. */
export const MUTATION_NAMES = Object.freeze([
    'actor-creations',
    'actor-destructions',
    'accessible-name-writes',
    'icon-name-writes',
    'label-text-writes',
    'menu-property-writes',
    'style-class-writes',
    'visibility-writes',
]);

/** Stores a bounded summary for one duration metric. */
export class DurationHistogram {
    constructor() {
        this.reset();
    }

    /** Removes all observations without reallocating bucket storage. */
    reset() {
        this.count = 0;
        this.sumUs = 0;
        this.minimumUs = null;
        this.maximumUs = null;
        this._buckets = this._buckets ?? new Uint32Array(DURATION_BUCKETS_US.length);
        this._buckets.fill(0);
    }

    /** Records one non-negative duration in microseconds. */
    observe(durationUs) {
        if (!Number.isFinite(durationUs) || durationUs < 0)
            throw new RangeError(`Invalid duration: ${durationUs}`);

        this.count++;
        this.sumUs += durationUs;
        this.minimumUs = this.minimumUs === null
            ? durationUs
            : Math.min(this.minimumUs, durationUs);
        this.maximumUs = this.maximumUs === null
            ? durationUs
            : Math.max(this.maximumUs, durationUs);

        const index = DURATION_BUCKETS_US.findIndex(bound => durationUs <= bound);
        this._buckets[index]++;
    }

    /** Returns a serializable copy of the current summary. */
    snapshot() {
        return {
            count: this.count,
            sumUs: this.sumUs,
            minimumUs: this.minimumUs,
            maximumUs: this.maximumUs,
            buckets: Array.from(this._buckets),
        };
    }
}

/** Collects bounded phase and actor-mutation summaries. */
export class Diagnostics {
    constructor(mode = DIAGNOSTICS_MODES.SUMMARY) {
        this._phases = Object.fromEntries(
            HARNESS_PHASES.map(name => [name, new DurationHistogram()]));
        this._mutations = Object.fromEntries(
            MUTATION_NAMES.map(name => [name, 0]));
        this._failures = {spawn: 0};
        this._cycleId = 0;
        this._traceId = 0;
        this._trace = null;
        this._traceActive = false;
        this._traceTiming = null;
        this.setMode(mode);
    }

    /** Changes diagnostic collection without changing visible state. */
    setMode(mode) {
        if (!Object.values(DIAGNOSTICS_MODES).includes(mode))
            throw new RangeError(`Unsupported diagnostics mode: ${mode}`);

        this.mode = mode;
    }

    /** Returns the next monotonically increasing visible-change identifier. */
    nextCycleId() {
        this._cycleId++;
        return this._cycleId;
    }

    /** Returns whether a transient detailed trace is active. */
    get traceActive() {
        return this._traceActive;
    }

    /** Starts one transient detailed trace and returns its identifier. */
    startTrace(timing = null) {
        if (this._traceActive)
            throw new Error('A diagnostic trace is already active');

        this._traceId++;
        this._trace = new TraceRing();
        this._traceActive = true;
        this._traceTiming = {
            startedMonotonicUs: timing?.monotonicUs ?? null,
            startedRealtimeUs: timing?.realtimeUs ?? null,
            endedMonotonicUs: null,
            endedRealtimeUs: null,
        };
        return this._traceId;
    }

    /** Stops the active detailed trace and returns its identifier. */
    stopTrace(timing = null) {
        if (!this._traceActive)
            return null;

        this._traceActive = false;
        this._traceTiming.endedMonotonicUs = timing?.monotonicUs ?? null;
        this._traceTiming.endedRealtimeUs = timing?.realtimeUs ?? null;
        return this._traceId;
    }

    /** Returns the stopped trace data needed by the asynchronous exporter. */
    stoppedTrace() {
        if (this._trace === null || this._traceActive)
            return null;

        return {
            id: this._traceId,
            timing: {...this._traceTiming},
            ring: this._trace,
        };
    }

    /** Records one numeric event in the active detailed trace. */
    recordTraceEvent(eventId, timestampUs, cycleId, viewId = 0) {
        if (this._traceActive)
            this._trace.record(eventId, timestampUs, cycleId, viewId);
    }

    /** Records one named synchronous phase duration. */
    recordDuration(name, durationUs) {
        if (this.mode === DIAGNOSTICS_MODES.OFF)
            return;

        const phase = this._phases[name];
        if (!phase)
            throw new RangeError(`Unsupported diagnostic phase: ${name}`);
        phase.observe(durationUs);
    }

    /** Increments one named actor mutation counter. */
    recordMutation(name, count = 1) {
        if (this.mode === DIAGNOSTICS_MODES.OFF)
            return;
        if (!Object.hasOwn(this._mutations, name))
            throw new RangeError(`Unsupported mutation: ${name}`);
        if (!Number.isInteger(count) || count < 0)
            throw new RangeError(`Invalid mutation count: ${count}`);

        this._mutations[name] += count;
    }

    /** Records a failed synthetic process launch or exit. */
    recordSpawnFailure() {
        if (this.mode !== DIAGNOSTICS_MODES.OFF)
            this._failures.spawn++;
    }

    /** Resets summaries while retaining their allocated storage. */
    reset() {
        for (const phase of Object.values(this._phases))
            phase.reset();
        for (const name of MUTATION_NAMES)
            this._mutations[name] = 0;
        this._failures.spawn = 0;
    }

    /** Returns a serializable copy of all bounded summaries. */
    snapshot() {
        return {
            mode: this.mode,
            cycleId: this._cycleId,
            phases: Object.fromEntries(Object.entries(this._phases)
                .map(([name, phase]) => [name, phase.snapshot()])),
            mutations: {...this._mutations},
            failures: {...this._failures},
            trace: this._trace === null
                ? null
                : {
                    id: this._traceId,
                    active: this._traceActive,
                    timing: {...this._traceTiming},
                    ...this._trace.summary(),
                },
        };
    }
}
