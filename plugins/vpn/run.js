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
    const bytes = new Soup.Session({timeout: 3}).send_and_read(message, null);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`VPN service returned HTTP ${message.status_code}`);
    if (bytes.get_size() > 64 * 1_024)
        throw new Error('VPN response exceeds 64 KiB');
    const status = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes.get_data()));
    print(JSON.stringify(vpnSnapshot(status)));
} catch (error) {
    printerr(`[vpn] ${error.message}`);
    System.exit(1);
}
