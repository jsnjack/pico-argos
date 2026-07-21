#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {summarizePresentation} from './presentation.js';

const MAX_CAPTURE_BYTES = 256 * 1_024 * 1_024;
const MAX_CORE_BYTES = 16 * 1_024 * 1_024;
const MAX_EVENTS = 500_000;
const MAX_LINE_BYTES = 4 * 1_024;

if (ARGV.length < 1 || ARGV.length > 2)
    throw new Error('Usage: analyze-presentation.js CAPTURE_NDJSON [CORE_TRACE_JSON]');
const events = readNdjson(ARGV[0]);
const core = ARGV.length === 2 ? readJson(ARGV[1], MAX_CORE_BYTES) : null;
print(JSON.stringify(summarizePresentation(events, core), null, 2));

function readNdjson(path) {
    const file = Gio.File.new_for_path(path);
    const size = file.query_info(
        Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
        Gio.FileQueryInfoFlags.NONE,
        null).get_size();
    if (size > MAX_CAPTURE_BYTES)
        throw new Error(`Presentation capture exceeds ${MAX_CAPTURE_BYTES} bytes`);
    const input = new Gio.DataInputStream({base_stream: file.read(null)});
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const events = [];
    try {
        while (events.length < MAX_EVENTS) {
            const [line, length] = input.read_line(null);
            if (line === null)
                return events;
            if (length > MAX_LINE_BYTES)
                throw new Error(`Presentation line exceeds ${MAX_LINE_BYTES} bytes`);
            events.push(JSON.parse(decoder.decode(line)));
        }
        const [extra] = input.read_line(null);
        if (extra !== null)
            throw new Error(`Presentation capture exceeds ${MAX_EVENTS} events`);
        return events;
    } finally {
        input.close(null);
    }
}

function readJson(path, maximumBytes) {
    const file = Gio.File.new_for_path(path);
    const size = file.query_info(
        Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
        Gio.FileQueryInfoFlags.NONE,
        null).get_size();
    if (size > maximumBytes)
        throw new Error(`JSON input exceeds ${maximumBytes} bytes: ${path}`);
    const [, bytes] = file.load_contents(null);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
