#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {vpnSnapshot} from './logic.js';

try {
    const uri = GLib.getenv('VPN_STATUS_URL') ??
        'https://web-api.nordvpn.com/v1/ips/info';
    if (!uri.startsWith('https://'))
        throw new Error('VPN_STATUS_URL must use HTTPS');
    const message = Soup.Message.new('GET', uri);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('User-Agent', 'pico-argos-vpn');
    const bytes = readBoundedResponse(
        new Soup.Session({timeout: 3}), message, 64 * 1_024);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`VPN service returned HTTP ${message.status_code}`);
    const status = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    print(JSON.stringify(vpnSnapshot(status)));
} catch (error) {
    printerr(`[vpn] ${error.message}`);
    System.exit(1);
}

function readBoundedResponse(session, message, maximumBytes) {
    const stream = session.send(message, null);
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const requestBytes = Math.min(8 * 1_024, maximumBytes + 1 - length);
            const block = stream.read_bytes(requestBytes, null);
            const chunk = new Uint8Array(block.get_data());
            if (chunk.length === 0)
                break;
            length += chunk.length;
            if (length > maximumBytes)
                throw new Error('VPN response exceeds 64 KiB');
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
