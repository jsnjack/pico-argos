// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseManifest} from '../../pico-argos@jsnjack.github.io/lib/manifest.js';

const root = Gio.File.new_for_path(GLib.build_filenamev([
    GLib.get_current_dir(),
    'tests',
    'performance',
    'plugins',
]));
const enumerator = root.enumerate_children(
    `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_STANDARD_TYPE}`,
    Gio.FileQueryInfoFlags.NONE,
    null);
let count = 0;
try {
    for (;;) {
        const info = enumerator.next_file(null);
        if (info === null)
            break;
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;
        const id = info.get_name();
        const directory = root.get_child(id);
        const [, bytes] = directory.get_child('plugin.json').load_contents(null);
        const manifest = parseManifest(
            new TextDecoder('utf-8', {fatal: true}).decode(bytes),
            directory.get_path(),
            id);
        if (manifest.id !== id)
            throw new Error(`Performance manifest id mismatch: ${id}`);
        count++;
    }
} finally {
    enumerator.close(null);
}
if (count !== 3)
    throw new Error(`Expected three performance plugins, found ${count}`);
print('ok - performance fixture plugins satisfy the public manifest contract');
