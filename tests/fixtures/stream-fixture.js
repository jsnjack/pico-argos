#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const stdout = GioUnix.OutputStream.new(1, false);
const stderr = GioUnix.OutputStream.new(2, false);
const encoder = new TextEncoder();
const snapshot = '{"version":1,"type":"snapshot","panel":{"text":"ok"},"menu":[]}\n';
const heartbeat = '{"version":1,"type":"heartbeat"}\n';

function write(stream, value) {
    stream.write_all(typeof value === 'string' ? encoder.encode(value) : value, null);
}

switch (ARGV[0]) {
    case 'messages':
        write(stdout, snapshot);
        write(stdout, heartbeat);
        break;
    case 'split-utf8': {
        const prefix = encoder.encode(
            '{"version":1,"type":"snapshot","panel":{"text":"');
        write(stdout, prefix);
        write(stdout, new Uint8Array([0xe2]));
        GLib.usleep(20_000);
        write(stdout, new Uint8Array([0x82, 0xac]));
        write(stdout, encoder.encode('"},"menu":[]}\n'));
        break;
    }
    case 'final-burst': {
        const burst = Array.from({length: 8}, (_value, index) => `${JSON.stringify({
            version: 1,
            type: 'snapshot',
            panel: {text: String(index)},
            menu: Array.from({length: 8}, (_item, itemIndex) => ({
                id: `item-${itemIndex}`,
                kind: 'label',
                text: 'x'.repeat(512),
            })),
        })}\n`).join('');
        Gio.Subprocess.new(
            ['/bin/sh', '-c', 'sleep 0.03; printf %s "$1"', 'pico-argos-burst', burst],
            Gio.SubprocessFlags.NONE);
        break;
    }
    case 'partial':
        write(stdout, snapshot.slice(0, -1));
        break;
    case 'message-flood':
        write(stdout, snapshot.repeat(3));
        GLib.usleep(1_000_000);
        break;
    case 'byte-flood':
        write(stdout, `${JSON.stringify({
            version: 1,
            type: 'snapshot',
            panel: {text: 'ok'},
            menu: Array.from({length: 64}, (_value, index) => ({
                id: `item-${index}`,
                kind: 'label',
                text: 'x'.repeat(512),
            })),
        })}\n`.repeat(2));
        GLib.usleep(1_000_000);
        break;
    case 'invalid-utf8':
        write(stdout, new Uint8Array([0xff, 0x0a]));
        break;
    case 'startup-timeout':
        GLib.usleep(2_000_000);
        break;
    case 'heartbeat-timeout':
        write(stdout, snapshot);
        GLib.usleep(2_000_000);
        break;
    case 'stderr-flood':
        write(stderr, new Uint8Array(65_537));
        GLib.usleep(2_000_000);
        break;
    case 'cancel':
        write(stdout, snapshot);
        GLib.usleep(2_000_000);
        break;
    case 'interactive': {
        const loop = GLib.MainLoop.new(null, false);
        const stdin = GioUnix.InputStream.new(0, false);
        const input = new Gio.DataInputStream({base_stream: stdin});
        write(stdout, `${JSON.stringify({
            version: 2,
            type: 'snapshot',
            panel: {text: 'Speakers · Microphone'},
            menu: [{
                id: 'output:44',
                kind: 'action',
                text: 'Speakers',
                selected: false,
            }],
        })}\n`);
        const read = () => input.read_line_async(
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                const [line] = source.read_line_finish(result);
                if (line === null) {
                    loop.quit();
                    return;
                }
                const request = JSON.parse(new TextDecoder().decode(line));
                write(stdout, `${JSON.stringify({
                    version: 2,
                    type: 'action-result',
                    requestId: request.requestId,
                    ok: true,
                })}\n`);
                write(stdout, `${JSON.stringify({
                    version: 2,
                    type: 'snapshot',
                    panel: {text: 'Speakers · Microphone'},
                    menu: [{
                        id: 'output:44',
                        kind: 'action',
                        text: 'Speakers',
                        selected: true,
                    }],
                })}\n`);
                read();
            });
        read();
        loop.run();
        break;
    }
    case 'interactive-menu-open': {
        const loop = GLib.MainLoop.new(null, false);
        const stdin = GioUnix.InputStream.new(0, false);
        const input = new Gio.DataInputStream({base_stream: stdin});
        write(stdout, `${JSON.stringify({
            version: 2,
            type: 'snapshot',
            panel: {text: 'Cached'},
            menu: [],
        })}\n`);
        const read = () => input.read_line_async(
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                const [line] = source.read_line_finish(result);
                if (line === null) {
                    loop.quit();
                    return;
                }
                const request = JSON.parse(new TextDecoder().decode(line));
                if (request.version !== 2 || request.type !== 'menu-open' ||
                    Object.keys(request).length !== 2)
                    throw new Error('Invalid menu-open request');
                write(stdout, `${JSON.stringify({
                    version: 2,
                    type: 'snapshot',
                    panel: {text: 'Refreshed'},
                    menu: [],
                })}\n`);
                read();
            });
        read();
        loop.run();
        break;
    }
    case 'interactive-no-result': {
        const loop = GLib.MainLoop.new(null, false);
        const stdin = GioUnix.InputStream.new(0, false);
        const input = new Gio.DataInputStream({base_stream: stdin});
        write(stdout, `${JSON.stringify({
            version: 2,
            type: 'snapshot',
            panel: {text: 'Audio'},
            menu: [{
                id: 'output:44',
                kind: 'action',
                text: 'Speakers',
                selected: false,
            }],
        })}\n`);
        input.read_line_async(
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                source.read_line_finish(result);
            });
        loop.run();
        break;
    }
    default:
        throw new Error(`Unknown fixture mode: ${ARGV[0]}`);
}
