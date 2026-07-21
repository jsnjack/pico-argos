#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import System from 'system';

const reply = Gio.DBus.session.call_sync(
    'org.gnome.Mutter.DisplayConfig',
    '/org/gnome/Mutter/DisplayConfig',
    'org.gnome.Mutter.DisplayConfig',
    'GetCurrentState',
    null,
    null,
    Gio.DBusCallFlags.NONE,
    3_000,
    null).deepUnpack();
const physical = [];
for (const [specification, modes, properties] of reply[1] ?? []) {
    const current = modes.find(mode => unpack(mode[6]?.['is-current']) === true);
    if (current === undefined)
        continue;
    physical.push({
        connector: specification[0],
        vendor: specification[1],
        product: specification[2],
        serial: specification[3],
        width: current[1],
        height: current[2],
        refreshRate: current[3],
        preferredScale: current[4],
        variableRefreshRate: unpack(properties?.['is-vrr-allowed']) ?? null,
    });
}
const logical = (reply[2] ?? []).map(monitor => ({
    x: monitor[0],
    y: monitor[1],
    scale: monitor[2],
    transform: monitor[3],
    primary: monitor[4],
    connectors: monitor[5].map(specification => specification[0]),
}));
const document = {
    formatVersion: 1,
    project: 'pico-argos',
    serial: reply[0],
    physical,
    logical,
};
print(JSON.stringify(document, null, 2));
if (ARGV.includes('--require-dual-120') &&
    (physical.length !== 2 || physical.some(monitor =>
        monitor.refreshRate < 119.5 || monitor.refreshRate > 120.5))) {
    printerr('Acceptance requires exactly two active monitors at 120 Hz');
    System.exit(1);
}

function unpack(value) {
    return typeof value?.deepUnpack === 'function' ? value.deepUnpack() : value;
}
