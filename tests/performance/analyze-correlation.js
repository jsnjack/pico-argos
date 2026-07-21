#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {analyzeCorrelation} from './correlation.js';

const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
if (ARGV.length !== 2)
    throw new Error('Usage: analyze-correlation.js SYSTEM_TRACE CORE_TRACE');
const analysis = analyzeCorrelation(readJson(ARGV[0]), readJson(ARGV[1]));
print(JSON.stringify(analysis, null, 2));
if (!analysis.freshnessGate.passed)
    imports.system.exit(1);

function readJson(path) {
    const file = Gio.File.new_for_path(path);
    const size = file.query_info(
        Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
        Gio.FileQueryInfoFlags.NONE,
        null).get_size();
    if (size > MAX_INPUT_BYTES)
        throw new Error(`Trace input exceeds ${MAX_INPUT_BYTES} bytes: ${path}`);
    const [, bytes] = file.load_contents(null);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
