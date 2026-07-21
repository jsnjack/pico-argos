#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

const value = String(Math.floor(GLib.get_monotonic_time() / 1_000) % 100_000)
    .padStart(5, '0');
print(JSON.stringify({
    version: 1,
    type: 'snapshot',
    panel: {
        visible: true,
        text: value,
        appearance: 'monospace',
        accessibleName: 'One-shot performance fixture',
        severity: 'normal',
    },
    menu: [],
}));
