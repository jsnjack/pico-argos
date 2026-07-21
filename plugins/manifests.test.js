// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {parseManifest} from '../pico-argos@jsnjack.github.io/lib/manifest.js';

for (const id of ['system-monitor', 'dependabot', 'pull-reviews', 'vpn', 'weather']) {
    const directory = GLib.build_filenamev([GLib.get_current_dir(), 'plugins', id]);
    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([directory, 'plugin.json']));
    const manifest = parseManifest(new TextDecoder().decode(bytes), directory, id);
    if (manifest.id !== id)
        throw new Error(`Reference manifest did not normalize: ${id}`);
    const source = GLib.build_filenamev([directory, 'run.js']);
    if (!GLib.file_test(source, GLib.FileTest.IS_EXECUTABLE))
        throw new Error(`Reference plugin executable is not executable: ${id}`);
}
print('ok - every reference plugin manifest satisfies the public contract');
