// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {parseManifest} from '../pico-argos@jsnjack.github.io/lib/manifest.js';
import {PANEL_TEXT_LIMIT} from './battery-power/logic.js';

for (const id of [
    'battery-power',
    'system-monitor',
    'audio-devices',
    'dependabot',
    'pull-reviews',
    'vpn',
    'weather',
]) {
    const directory = GLib.build_filenamev([GLib.get_current_dir(), 'plugins', id]);
    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([directory, 'plugin.json']));
    const manifest = parseManifest(new TextDecoder().decode(bytes), directory, id);
    if (manifest.id !== id)
        throw new Error(`Reference manifest did not normalize: ${id}`);
    if (id === 'battery-power' &&
        (manifest.position !== 'left' || manifest.mode !== 'stream'))
        throw new Error('Battery power must stream beside the system monitor');
    if (id === 'battery-power' && manifest.reserveTextChars !== PANEL_TEXT_LIMIT)
        throw new Error('Battery power must reserve the width its panel uses');
    if (id === 'system-monitor' && manifest.reserveTextChars !== 0)
        throw new Error('System monitor must size naturally for selected fields');
    if (id === 'system-monitor' && manifest.position !== 'left')
        throw new Error('System monitor must use the available left panel space');
    if (id === 'audio-devices' && manifest.protocolVersion !== 2)
        throw new Error('Audio devices must use the interactive protocol');
    if (id === 'audio-devices' && !manifest.refreshOnOpen)
        throw new Error('Audio devices must refresh when its menu opens');
    if (id === 'audio-devices' &&
        (manifest.position !== 'right' || manifest.order !== 40))
        throw new Error('Audio devices must sit beside the right-side system controls');
    const source = GLib.build_filenamev([directory, 'run.js']);
    if (!GLib.file_test(source, GLib.FileTest.IS_EXECUTABLE))
        throw new Error(`Reference plugin executable is not executable: ${id}`);
}
print('ok - every reference plugin manifest satisfies the public contract');
