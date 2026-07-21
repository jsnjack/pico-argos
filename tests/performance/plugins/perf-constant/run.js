#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

const snapshot = JSON.stringify({
    version: 1,
    type: 'snapshot',
    panel: {
        visible: true,
        text: '00000',
        appearance: 'monospace',
        accessibleName: 'Constant performance fixture',
        severity: 'normal',
    },
    menu: [],
});
print(snapshot);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    print(snapshot);
    return GLib.SOURCE_CONTINUE;
});
new GLib.MainLoop(null, false).run();
