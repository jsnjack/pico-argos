// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

const MINIMUM_BATCH_INTERVAL_US = 100_000;

/** Coalesces every plugin to its latest model in at most ten UI batches/s. */
export class RenderCoordinator {
    constructor({clock, apply, timer = null, onBatch = null}) {
        if (typeof clock?.nowUs !== 'function')
            throw new TypeError('RenderCoordinator requires a monotonic clock');
        if (typeof apply !== 'function')
            throw new TypeError('RenderCoordinator requires an apply callback');
        this._clock = clock;
        this._apply = apply;
        this._timer = timer ?? new RenderTimer();
        this._onBatch = onBatch;
        this._pending = new Map();
        this._source = null;
        this._lastApplyUs = null;
        this._enabled = true;
    }

    /** Queues only the latest complete presentation for one plugin. */
    queue(plugin, presentation) {
        if (!this._enabled)
            return;
        const previous = this._pending.get(plugin.id);
        this._pending.set(plugin.id, {
            plugin,
            presentation,
            queuedUs: previous?.queuedUs ?? this._clock.nowUs(),
        });
        this._arm();
    }

    /** Removes work queued for a plugin that no longer exists. */
    remove(pluginId) {
        this._pending.delete(pluginId);
    }

    /** Removes the single source and rejects all late work. */
    stop() {
        this._enabled = false;
        if (this._source !== null) {
            this._timer.cancel(this._source);
            this._source = null;
        }
        this._pending.clear();
    }

    _arm() {
        if (this._source !== null || this._pending.size === 0)
            return;
        const nowUs = this._clock.nowUs();
        const remainingUs = this._lastApplyUs === null
            ? 0
            : Math.max(0, MINIMUM_BATCH_INTERVAL_US - (nowUs - this._lastApplyUs));
        this._source = this._timer.schedule(Math.ceil(remainingUs / 1_000), () => {
            this._source = null;
            this._flush();
        });
    }

    _flush() {
        if (!this._enabled || this._pending.size === 0)
            return;
        const applyBeginUs = this._clock.nowUs();
        const pending = this._pending;
        this._pending = new Map();
        let writes = 0;
        let earliestQueuedUs = applyBeginUs;
        for (const entry of pending.values()) {
            earliestQueuedUs = Math.min(earliestQueuedUs, entry.queuedUs);
            writes += this._apply(entry.plugin, entry.presentation) ?? 0;
        }
        const applyEndUs = this._clock.nowUs();
        this._lastApplyUs = applyEndUs;
        this._onBatch?.({
            applyBeginUs,
            applyEndUs,
            queueWaitUs: applyBeginUs - earliestQueuedUs,
            pluginCount: pending.size,
            writes,
        });
        this._arm();
    }
}

class RenderTimer {
    schedule(delayMs, callback) {
        if (delayMs === 0) {
            return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            });
        }
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, delayMs, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel(sourceId) {
        GLib.source_remove(sourceId);
    }
}
