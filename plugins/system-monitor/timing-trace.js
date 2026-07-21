// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const TIMING_TRACE_CAPACITY = 16_384;

/** Retains opt-in system-sample timing in fixed numeric storage. */
export class SystemTimingTrace {
    constructor(path, capacity = TIMING_TRACE_CAPACITY) {
        if (typeof path !== 'string' || !GLib.path_is_absolute(path) ||
            new TextEncoder().encode(path).length > 4_096 || /[\u0000-\u001f]/.test(path)) {
            throw new Error('diagnosticTracePath must be a bounded absolute path');
        }
        if (!Number.isInteger(capacity) || capacity < 1 ||
            capacity > TIMING_TRACE_CAPACITY) {
            throw new Error(`Invalid system timing trace capacity: ${capacity}`);
        }
        this.path = path;
        this.capacity = capacity;
        this.length = 0;
        this.dropped = 0;
        this.startedMonotonicUs = GLib.get_monotonic_time();
        this.startedRealtimeUs = GLib.get_real_time();
        this._fields = Array.from({length: 8}, () => new Float64Array(capacity));
    }

    /** Records one fast sampling cycle without growing retained storage. */
    record(values) {
        if (!Array.isArray(values) || values.length !== this._fields.length ||
            values.some(value => !Number.isFinite(value) || value < 0)) {
            throw new Error('System timing trace values must be eight non-negative numbers');
        }
        if (this.length === this.capacity) {
            this.dropped++;
            return false;
        }
        const index = this.length++;
        values.forEach((value, field) => {
            this._fields[field][index] = value;
        });
        return true;
    }

    /** Writes one private bounded JSON document from the plugin process. */
    export() {
        const file = Gio.File.new_for_path(this.path);
        const stream = file.replace(
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            null);
        try {
            write(stream, `${JSON.stringify({
                formatVersion: 1,
                project: 'pico-argos',
                plugin: 'system-monitor',
                startedMonotonicUs: this.startedMonotonicUs,
                startedRealtimeUs: this.startedRealtimeUs,
                endedMonotonicUs: GLib.get_monotonic_time(),
                endedRealtimeUs: GLib.get_real_time(),
                capacity: this.capacity,
                eventCount: this.length,
                dropped: this.dropped,
                eventSchema: [
                    'scheduledDeadlineUs',
                    'sampleBeginUs',
                    'sampleEndUs',
                    'formatBeginUs',
                    'formatEndUs',
                    'writeBeginUs',
                    'writeEndUs',
                    'outputSequence',
                ],
            }).slice(0, -1)},"events":[`);
            for (let index = 0; index < this.length; index++) {
                const event = this._fields.map(field => field[index]);
                write(stream, `${index === 0 ? '' : ','}${JSON.stringify(event)}`);
            }
            write(stream, ']}\n');
        } finally {
            stream.close(null);
        }
    }
}

function write(stream, value) {
    stream.write_all(new TextEncoder().encode(value), null);
}
