#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

const stdout = GioUnix.OutputStream.new(1, false);
const stderr = GioUnix.OutputStream.new(2, false);
const mode = ARGV[0];

function write(stream, bytes) {
    stream.write_all(bytes, null);
}

function text(value) {
    return new TextEncoder().encode(value);
}

switch (mode) {
    case 'constant':
        write(stdout, text('{"version":1,"type":"snapshot","panel":{"text":"ok"},"menu":[]}'));
        break;
    case 'environment':
        write(stdout, text(JSON.stringify({
            protocol: GLib.getenv('PICO_ARGOS_PROTOCOL'),
            menuOpen: GLib.getenv('PICO_ARGOS_MENU_OPEN'),
            pluginId: GLib.getenv('PICO_ARGOS_PLUGIN_ID'),
        })));
        break;
    case 'chunked':
        write(stdout, text('{"version":1,'));
        GLib.usleep(20_000);
        write(stdout, text('"type":"snapshot","panel":{"text":"ok"},"menu":[]}'));
        break;
    case 'exact-limit':
        write(stdout, text('x'.repeat(64 * 1_024)));
        break;
    case 'stdout-flood':
        write(stdout, text('x'.repeat(64 * 1_024 + 1)));
        break;
    case 'stderr-flood':
        write(stderr, text('x'.repeat(8 * 1_024 + 1)));
        GLib.usleep(1_000_000);
        break;
    case 'invalid-utf8':
        write(stdout, new Uint8Array([0xff]));
        break;
    case 'nonzero':
        write(stderr, text('fixture failure'));
        System.exit(7);
        break;
    case 'timeout':
        GLib.usleep(2_000_000);
        break;
    default:
        throw new Error(`Unknown fixture mode: ${mode}`);
}
