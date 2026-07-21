#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import System from 'system';

import {comparePresentationRuns} from './presentation.js';

const MAX_SUMMARY_BYTES = 1 * 1_024 * 1_024;
if (ARGV.length < 10 || ARGV.length % 2 !== 0) {
    throw new Error(
        'Usage: compare-presentation.js BASELINE_JSON SCENARIO_JSON ' +
        '[BASELINE_JSON SCENARIO_JSON ...]');
}
const baselines = [];
const scenarios = [];
for (let index = 0; index < ARGV.length; index += 2) {
    baselines.push(readJson(ARGV[index]));
    scenarios.push(readJson(ARGV[index + 1]));
}
const comparison = comparePresentationRuns(baselines, scenarios);
print(JSON.stringify(comparison, null, 2));
if (!comparison.frameRateGate.passed)
    System.exit(1);

function readJson(path) {
    const file = Gio.File.new_for_path(path);
    const size = file.query_info(
        Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
        Gio.FileQueryInfoFlags.NONE,
        null).get_size();
    if (size > MAX_SUMMARY_BYTES)
        throw new Error(`Summary exceeds ${MAX_SUMMARY_BYTES} bytes: ${path}`);
    const [, bytes] = file.load_contents(null);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
