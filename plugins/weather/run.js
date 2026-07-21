#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {weatherSnapshot} from './logic.js';

const WEATHER_SOURCE = 'https://weather.yauhen.cc/api/v1/glance';

try {
    const message = Soup.Message.new('GET', WEATHER_SOURCE);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('User-Agent', 'argos-weather/1.0');
    const bytes = readBoundedResponse(
        new Soup.Session({timeout: 15}), message, 1_048_576);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`Weather service returned HTTP ${message.status_code}`);
    const data = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    print(JSON.stringify(weatherSnapshot(data)));
} catch (error) {
    printerr(`[weather] ${error.message}`);
    System.exit(1);
}

function readBoundedResponse(session, message, maximumBytes) {
    const stream = session.send(message, null);
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const requestBytes = Math.min(64 * 1_024, maximumBytes + 1 - length);
            const block = stream.read_bytes(requestBytes, null);
            const chunk = new Uint8Array(block.get_data());
            if (chunk.length === 0)
                break;
            length += chunk.length;
            if (length > maximumBytes)
                throw new Error('Weather response exceeds 1 MiB');
            chunks.push(chunk);
        }
    } finally {
        stream.close(null);
    }
    return joinChunks(chunks, length);
}

function joinChunks(chunks, length) {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}
