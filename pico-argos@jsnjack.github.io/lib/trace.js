// SPDX-License-Identifier: GPL-3.0-or-later

/** Maximum numeric event slots retained by one trace session. */
export const TRACE_CAPACITY = 16_384;

/** Numeric event identifiers used by the Phase 0 trace. */
export const TRACE_EVENTS = Object.freeze({
    UI_APPLY_END: 1,
    STAGE_BEFORE_UPDATE: 2,
    STAGE_BEFORE_PAINT: 3,
    STAGE_AFTER_PAINT: 4,
    STAGE_PRESENTED: 5,
    SCHEDULED_DUE: 6,
    SCHEDULER_CALLBACK_BEGIN: 7,
    LAUNCH_BEGIN: 8,
    SPAWN_RETURN: 9,
    FIRST_STDOUT_BYTE: 10,
    STREAM_FIRST_SNAPSHOT: 11,
    STREAM_LINE_COMPLETE: 12,
    STREAM_HEARTBEAT: 13,
    STREAM_RESTART_SCHEDULED: 14,
    STDOUT_EOF: 15,
    STDERR_EOF: 16,
    PROCESS_EXIT: 17,
    DECODE_BEGIN: 18,
    DECODE_END: 19,
    RAW_COMPARE_END: 20,
    PARSE_BEGIN: 21,
    PARSE_END: 22,
    VALIDATE_END: 23,
    SEMANTIC_DIFF_END: 24,
    UI_QUEUED: 25,
    UI_APPLY_BEGIN: 26,
    SNAPSHOT_ACCEPTED: 27,
});

/** Stores one trace session in fixed-capacity numeric arrays. */
export class TraceRing {
    constructor(capacity = TRACE_CAPACITY) {
        if (!Number.isInteger(capacity) || capacity < 1)
            throw new RangeError(`Invalid trace capacity: ${capacity}`);

        this.capacity = capacity;
        this.length = 0;
        this.dropped = 0;
        this._eventIds = new Uint8Array(capacity);
        this._timestampsUs = new Float64Array(capacity);
        this._cycleIds = new Float64Array(capacity);
        this._viewIds = new Uint32Array(capacity);
    }

    /** Records one event or increments the dropped-event counter when full. */
    record(eventId, timestampUs, cycleId, viewId = 0) {
        if (this.length === this.capacity) {
            this.dropped++;
            return false;
        }

        const index = this.length++;
        this._eventIds[index] = eventId;
        this._timestampsUs[index] = timestampUs;
        this._cycleIds[index] = cycleId;
        this._viewIds[index] = viewId;
        return true;
    }

    /** Returns bounded session metadata without allocating an event history. */
    summary() {
        return {
            capacity: this.capacity,
            eventCount: this.length,
            dropped: this.dropped,
        };
    }

    /** Returns one numeric event without allocating the complete history. */
    eventAt(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.length)
            throw new RangeError(`Invalid trace event index: ${index}`);

        return [
            this._eventIds[index],
            this._timestampsUs[index],
            this._cycleIds[index],
            this._viewIds[index],
        ];
    }

    /** Returns a serializable event copy for a stopped-session export. */
    events() {
        const events = new Array(this.length);
        for (let index = 0; index < this.length; index++)
            events[index] = this.eventAt(index);
        return events;
    }
}
