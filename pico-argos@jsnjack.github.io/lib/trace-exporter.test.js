// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MonotonicClock} from './clock.js';
import {TraceExporter} from './trace-exporter.js';
import {TraceRing, TRACE_EVENTS} from './trace.js';

const temporaryDirectory = GLib.dir_make_tmp('pico-argos-export-test.XXXXXX');
const trace = new TraceRing(1);
trace.record(TRACE_EVENTS.UI_APPLY_END, 100, 1);
const loop = new GLib.MainLoop(null, false);
let exportPath = null;
let failure = null;

const exporter = new TraceExporter(
    new MonotonicClock(),
    {
        id: 7,
        timing: {
            startedMonotonicUs: 50,
            startedRealtimeUs: 1_000,
            endedMonotonicUs: 150,
            endedRealtimeUs: 1_100,
        },
        ring: trace,
    },
    {formatVersion: 1, trace: {id: 7}},
    {
        onComplete: path => {
            exportPath = path;
            loop.quit();
        },
        onError: error => {
            failure = error;
            loop.quit();
        },
    },
    temporaryDirectory);

exporter.start();
const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    failure = new Error('Trace export timed out');
    exporter.cancel();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
GLib.source_remove(timeoutId);

if (failure !== null)
    throw failure;

const file = Gio.File.new_for_path(exportPath);
const [, contents] = file.load_contents(null);
const document = JSON.parse(new TextDecoder().decode(contents));
if (document.trace.id !== 7)
    throw new Error(`Unexpected exported trace ID: ${document.trace.id}`);
if (JSON.stringify(document.events) !== JSON.stringify(trace.events()))
    throw new Error('Asynchronous trace export corrupted event data');

file.delete(null);
file.get_parent().delete(null);
file.get_parent().get_parent().delete(null);
Gio.File.new_for_path(temporaryDirectory).delete(null);
print('ok - trace export writes valid JSON through asynchronous GIO');
