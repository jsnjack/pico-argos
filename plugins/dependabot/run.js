#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {dependabotSnapshot} from './logic.js';

try {
    const token = requiredEnvironment('GITHUB_TOKEN');
    const repository = requiredEnvironment('GITHUB_REPOSITORY');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
        throw new Error('GITHUB_REPOSITORY must have owner/name form');
    const alerts = requestJson(
        `https://api.github.com/repos/${repository}/dependabot/alerts` +
            '?state=open&severity=critical&per_page=100',
        token);
    if (alerts.length === 100)
        throw new Error('Critical alert count exceeds the bounded GitHub page');
    print(JSON.stringify(dependabotSnapshot(alerts, repository)));
} catch (error) {
    printerr(`[dependabot] ${error.message}`);
    System.exit(1);
}

function requestJson(uri, token) {
    const session = new Soup.Session({timeout: 20});
    const message = Soup.Message.new('GET', uri);
    message.request_headers.append('Accept', 'application/vnd.github+json');
    message.request_headers.append('Authorization', `Bearer ${token}`);
    message.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
    message.request_headers.append('User-Agent', 'pico-argos-dependabot');
    const bytes = readBoundedResponse(session, message, 1_048_576);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`GitHub returned HTTP ${message.status_code}`);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
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
                throw new Error('GitHub response exceeds 1 MiB');
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

function requiredEnvironment(name) {
    const value = GLib.getenv(name);
    if (value === null || value.length === 0)
        throw new Error(`${name} is required`);
    return value;
}
