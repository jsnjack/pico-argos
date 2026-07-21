// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SystemTimingTrace} from './timing-trace.js';

const directory = GLib.dir_make_tmp('pico-argos-system-trace-test.XXXXXX');
const path = GLib.build_filenamev([directory, 'timing.json']);
const trace = new SystemTimingTrace(path, 2);
if (!trace.record([100, 110, 120, 121, 122, 123, 124, 1]) ||
    !trace.record([200, 210, 220, 221, 222, 0, 0, 0]) ||
    trace.record([300, 310, 320, 321, 322, 323, 324, 2])) {
    throw new Error('System timing trace did not enforce its fixed capacity');
}
trace.export();
const file = Gio.File.new_for_path(path);
const [, bytes] = file.load_contents(null);
const document = JSON.parse(new TextDecoder().decode(bytes));
if (document.eventCount !== 2 || document.dropped !== 1 ||
    document.events.length !== 2 || document.events[0][7] !== 1 ||
    document.events[1][5] !== 0) {
    throw new Error(`System timing trace export is invalid: ${JSON.stringify(document)}`);
}
file.delete(null);
Gio.File.new_for_path(directory).delete(null);
print('ok - system timing trace is fixed-size and exports correlated samples');
