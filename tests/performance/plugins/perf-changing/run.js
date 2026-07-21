#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

let value = 0;
emit();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    emit();
    return GLib.SOURCE_CONTINUE;
});
new GLib.MainLoop(null, false).run();

function emit() {
    print(JSON.stringify({
        version: 1,
        type: 'snapshot',
        panel: {
            visible: true,
            text: String(value++ % 100_000).padStart(5, '0'),
            appearance: 'monospace',
            accessibleName: 'Changing performance fixture',
            severity: 'normal',
        },
        menu: [],
    }));
}
