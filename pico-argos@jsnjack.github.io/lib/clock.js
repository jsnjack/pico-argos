// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

/** Provides monotonic microsecond timestamps. */
export class MonotonicClock {
    /** Returns the current monotonic timestamp in microseconds. */
    nowUs() {
        return GLib.get_monotonic_time();
    }
}
