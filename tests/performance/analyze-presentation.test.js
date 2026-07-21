// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const gjs = GLib.find_program_in_path('gjs');
if (gjs === null)
    throw new Error('gjs is not on PATH');
const scriptPath = GLib.build_filenamev([
    GLib.get_current_dir(), 'tests', 'performance', 'analyze-presentation.js',
]);

const root = GLib.dir_make_tmp('pico-argos-presentation-cli-test.XXXXXX');
const capturePath = GLib.build_filenamev([root, 'presentation.ndjson']);
const captureFile = Gio.File.new_for_path(capturePath);

function writeCapture(text) {
    captureFile.replace_contents(
        text, null, false, Gio.FileCreateFlags.PRIVATE, null);
}

function runAnalyzer() {
    const process = Gio.Subprocess.new(
        [gjs, '-m', scriptPath, capturePath],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, stdout, stderr] = process.communicate_utf8(null, null);
    return {exitStatus: process.get_exit_status(), stdout, stderr};
}

const interval = 8_333_333;
const start = 2_000_000_000;
function presented(submission, timestamp) {
    return {
        type: 'presented',
        submission,
        submittedMonotonicNanoseconds: timestamp - 2_000_000,
        receivedMonotonicNanoseconds: timestamp + 100_000,
        presentationSeconds: Math.floor(timestamp / 1_000_000_000),
        presentationNanoseconds: timestamp % 1_000_000_000,
        refreshNanoseconds: interval,
        sequenceHigh: 0,
        sequenceLow: submission,
        flags: 1,
    };
}

// A real saved capture file, read from disk exactly as run-acceptance.sh
// leaves it, with two presented frames and one discarded frame.
writeCapture([
    {type: 'environment', presentationClockId: 1},
    presented(1, start),
    presented(2, start + interval),
    {
        type: 'discarded',
        submission: 3,
        submittedMonotonicNanoseconds: start + interval * 2,
        receivedMonotonicNanoseconds: start + interval * 2 + 50_000,
    },
].map(event => JSON.stringify(event)).join('\n') + '\n');

const happyPath = runAnalyzer();
if (happyPath.exitStatus !== 0) {
    throw new Error(
        `Analyzer rejected a valid saved capture: ${happyPath.stderr}`);
}
const summary = JSON.parse(happyPath.stdout);
if (summary.presentedFrames !== 2 || summary.discardedFrames !== 1 ||
    summary.intervalNanoseconds.count !== 1 ||
    summary.intervalNanoseconds.mean !== interval) {
    throw new Error(
        `Unexpected analysis of a real saved capture: ${happyPath.stdout}`);
}

// A line exceeding the 4-KiB per-line bound must fail the whole capture
// rather than silently truncating it.
writeCapture(
    `${JSON.stringify({type: 'environment', presentationClockId: 1})}\n` +
    `{"type":"padding","value":"${'x'.repeat(5_000)}"}\n`);
const oversizedLine = runAnalyzer();
if (oversizedLine.exitStatus === 0)
    throw new Error('Analyzer accepted a capture line exceeding the byte bound');

GLib.unlink(capturePath);
GLib.rmdir(root);
print('ok - analyze-presentation.js reads a real saved NDJSON capture from disk');
