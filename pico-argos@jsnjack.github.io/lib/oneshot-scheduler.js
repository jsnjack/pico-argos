// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

const PRIORITY_PERIODIC = 0;
const PRIORITY_REFRESH = 1;

/** Owns one deadline source and serializes all one-shot plugin runs. */
export class OneShotScheduler {
    constructor({clock, run, timer = null, onEvent = null, onPhase = null}) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('OneShotScheduler requires a monotonic clock');
        if (typeof run !== 'function')
            throw new TypeError('OneShotScheduler requires a run callback');
        this._clock = clock;
        this._run = run;
        this._timer = timer ?? new GLibDeadlineTimer();
        this._onEvent = onEvent;
        this._onPhase = onPhase;
        this._records = new Map();
        this._active = null;
        this._source = null;
        this._started = false;
        this._generation = 0;
        this._lastDispatched = new Map();
    }

    /** Registers or replaces one normalized one-shot manifest. */
    setPlugin(manifest) {
        if (manifest.mode !== 'oneshot')
            throw new TypeError('OneShotScheduler accepts one-shot manifests only');
        const nowUs = this._clock.nowUs();
        const previous = this._records.get(manifest.id);
        this._records.set(manifest.id, {
            manifest,
            nextDueUs: nextPhasedDeadline(nowUs, manifest.intervalMs, manifest.id),
            pending: null,
            running: previous?.running ?? false,
            skipped: previous?.skipped ?? 0,
        });
        if (this._started)
            this._arm();
    }

    /** Removes pending and future work for one plugin. */
    removePlugin(pluginId) {
        this._records.delete(pluginId);
        if (this._started)
            this._arm();
    }

    /** Starts deadline processing. */
    start() {
        if (this._started)
            throw new Error('OneShotScheduler is already started');
        this._started = true;
        this._generation++;
        this._poll();
    }

    /** Prevents new work and removes the single deadline source. */
    stop() {
        this._started = false;
        this._generation++;
        if (this._source !== null) {
            this._timer.cancel(this._source);
            this._source = null;
        }
        for (const record of this._records.values())
            record.pending = null;
    }

    /** Stops scheduling and releases all retained plugin records. */
    destroy() {
        this.stop();
        this._active = null;
        this._records.clear();
        this._lastDispatched.clear();
        this._run = null;
        this._onEvent = null;
        this._onPhase = null;
    }

    /** Coalesces one menu-open refresh ahead of periodic work. */
    requestRefresh(pluginId) {
        const record = this._records.get(pluginId);
        if (!this._started || record === undefined || !record.manifest.refreshOnOpen)
            return false;
        this._enqueue(record, PRIORITY_REFRESH, this._clock.nowUs(), 'refresh');
        this._pump();
        this._arm();
        return true;
    }

    /** Coalesces one explicit user refresh regardless of open-refresh policy. */
    requestManual(pluginId) {
        const record = this._records.get(pluginId);
        if (!this._started || record === undefined)
            return false;
        this._enqueue(record, PRIORITY_REFRESH, this._clock.nowUs(), 'manual');
        this._pump();
        this._arm();
        return true;
    }

    /** Processes due deadlines; exposed to deterministic tests. */
    poll() {
        if (this._started)
            this._poll();
    }

    /** Returns bounded scheduling state for diagnostics and tests. */
    snapshot() {
        return {
            activePluginId: this._active,
            plugins: [...this._records.values()].map(record => ({
                id: record.manifest.id,
                nextDueUs: record.nextDueUs,
                pending: record.pending === null ? null : {
                    reason: record.pending.reason,
                    deadlineUs: record.pending.deadlineUs,
                },
                running: record.running,
                skipped: record.skipped,
            })),
        };
    }

    _poll() {
        const callbackBeginUs = this._clock.nowUs();
        try {
            this._pollAt(callbackBeginUs);
        } finally {
            this._onPhase?.(
                'scheduler-callback',
                this._clock.nowUs() - callbackBeginUs,
                null);
        }
    }

    _pollAt(nowUs) {
        if (this._source !== null) {
            this._timer.cancel(this._source);
            this._source = null;
        }
        for (const record of this._records.values()) {
            if (record.nextDueUs > nowUs)
                continue;
            const deadlineUs = record.nextDueUs;
            const missed = Math.floor(
                (nowUs - deadlineUs) / (record.manifest.intervalMs * 1_000));
            const occurrences = missed + 1;
            if (record.running || record.pending !== null) {
                record.skipped += occurrences;
                this._onEvent?.({
                    kind: 'skipped',
                    pluginId: record.manifest.id,
                    count: occurrences,
                });
            } else {
                this._enqueue(record, PRIORITY_PERIODIC, deadlineUs, 'periodic');
                if (occurrences > 1) {
                    record.skipped += occurrences - 1;
                    this._onEvent?.({
                        kind: 'skipped',
                        pluginId: record.manifest.id,
                        count: occurrences - 1,
                    });
                }
            }
            record.nextDueUs = deadlineUs +
                occurrences * record.manifest.intervalMs * 1_000;
        }
        this._pump();
        this._arm();
    }

    _enqueue(record, priority, deadlineUs, reason) {
        if (record.pending === null || priority > record.pending.priority) {
            record.pending = {priority, deadlineUs, reason};
            return;
        }
        if (priority === record.pending.priority) {
            record.pending.deadlineUs = Math.min(record.pending.deadlineUs, deadlineUs);
            if (reason === 'refresh')
                record.pending.reason = reason;
        }
    }

    _pump() {
        if (!this._started || this._active !== null)
            return;
        const candidates = [...this._records.values()]
            .filter(record => record.pending !== null && !record.running)
            .sort(comparePending);
        if (candidates.length === 0)
            return;

        const priority = candidates[0].pending.priority;
        const samePriority = candidates.filter(candidate =>
            candidate.pending.priority === priority);
        const lastDispatched = this._lastDispatched.get(priority);
        const record = samePriority.length > 1
            ? samePriority.find(candidate => candidate.manifest.id !== lastDispatched) ??
                samePriority[0]
            : samePriority[0];
        const token = record.pending;
        record.pending = null;
        record.running = true;
        this._active = record.manifest.id;
        this._lastDispatched.set(priority, record.manifest.id);
        const generation = this._generation;
        this._onEvent?.({
            kind: 'started',
            pluginId: record.manifest.id,
            reason: token.reason,
            deadlineUs: token.deadlineUs,
        });

        Promise.resolve().then(() => this._run(record.manifest, {
            reason: token.reason,
            menuOpen: token.reason === 'refresh',
            deadlineUs: token.deadlineUs,
        })).catch(error => {
            this._onEvent?.({kind: 'run-error', pluginId: record.manifest.id, error});
        }).finally(() => {
            const current = this._records.get(record.manifest.id);
            if (current !== undefined)
                current.running = false;
            if (generation !== this._generation)
                return;
            this._active = null;
            this._onEvent?.({kind: 'finished', pluginId: record.manifest.id});
            this._poll();
        });
    }

    _arm() {
        if (!this._started)
            return;
        if (this._source !== null) {
            this._timer.cancel(this._source);
            this._source = null;
        }
        let nextDueUs = Number.POSITIVE_INFINITY;
        for (const record of this._records.values())
            nextDueUs = Math.min(nextDueUs, record.nextDueUs);
        if (!Number.isFinite(nextDueUs))
            return;
        const delayMs = Math.max(
            1,
            Math.ceil((nextDueUs - this._clock.nowUs()) / 1_000));
        this._source = this._timer.schedule(delayMs, () => {
            this._source = null;
            this._poll();
        });
    }
}

class GLibDeadlineTimer {
    schedule(delayMs, callback) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel(sourceId) {
        GLib.source_remove(sourceId);
    }
}

function comparePending(left, right) {
    return right.pending.priority - left.pending.priority ||
        left.pending.deadlineUs - right.pending.deadlineUs ||
        left.manifest.id.localeCompare(right.manifest.id);
}

function nextPhasedDeadline(nowUs, intervalMs, pluginId) {
    const intervalUs = intervalMs * 1_000;
    const startupWindowUs = Math.min(intervalUs, 1_000_000);
    return nowUs + 1 + stableHash(pluginId) % startupWindowUs;
}

function stableHash(value) {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash;
}
