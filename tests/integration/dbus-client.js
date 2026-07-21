#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.gnome.Shell.Extensions.PicoArgos';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/PicoArgos';
const INTERFACE = 'org.gnome.Shell.Extensions.PicoArgos.Diagnostics1';

const command = ARGV[0];
let method;
let parameters = null;
if (command === 'summary') {
    method = 'GetSummary';
} else if (command === 'start-trace') {
    method = 'StartTrace';
    parameters = GLib.Variant.new('(u)', [Number(ARGV[1])]);
} else if (command === 'stop-trace') {
    method = 'StopTrace';
} else {
    throw new Error(`Unknown diagnostic command: ${command}`);
}

const result = Gio.DBus.session.call_sync(
    BUS_NAME,
    OBJECT_PATH,
    INTERFACE,
    method,
    parameters,
    null,
    Gio.DBusCallFlags.NONE,
    3_000,
    null).deepUnpack();
if (command === 'summary')
    print(result[0]);
else if (command === 'start-trace')
    print(result[0]);
