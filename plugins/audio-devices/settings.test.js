// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {audioSettings, readAudioSettings} from './settings.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertRejects(callback, pattern) {
    try {
        callback();
    } catch (error) {
        if (!pattern.test(error.message))
            throw new Error(`Unexpected rejection: ${error.message}`);
        return;
    }
    throw new Error(`Invalid settings were accepted; expected ${pattern}`);
}

function withSettingsVariable(value, callback) {
    const previous = GLib.getenv('PICO_ARGOS_CONFIG');
    if (value === null)
        GLib.unsetenv('PICO_ARGOS_CONFIG');
    else
        GLib.setenv('PICO_ARGOS_CONFIG', value, true);
    try {
        return callback();
    } finally {
        if (previous === null)
            GLib.unsetenv('PICO_ARGOS_CONFIG');
        else
            GLib.setenv('PICO_ARGOS_CONFIG', previous, true);
    }
}

const cases = [
    ['uses the defaults when the variable is unset', () => {
        assertEqual(withSettingsVariable(null, readAudioSettings),
            {maxPanelNameChars: 18, aliases: {}}, 'settings');
        assertEqual(audioSettings('{}'), {maxPanelNameChars: 18, aliases: {}}, 'empty object');
    }],
    ['reads aliases from PICO_ARGOS_CONFIG', () => {
        const settings = withSettingsVariable(JSON.stringify({
            maxPanelNameChars: 24,
            aliases: {'alsa_output.pci-0000_00_1f.3.analog-stereo': ' Speakers '},
        }), readAudioSettings);
        assertEqual(settings, {
            maxPanelNameChars: 24,
            aliases: {'alsa_output.pci-0000_00_1f.3.analog-stereo': 'Speakers'},
        }, 'settings');
    }],
    ['rejects unknown or invalid settings', () => {
        assertRejects(() => audioSettings('{"alias":{}}'), /unknown field: alias/);
        assertRejects(() => audioSettings('{"maxPanelNameChars":5}'), /6 through 48/);
        assertRejects(() => audioSettings('{"aliases":["Speakers"]}'), /must be an object/);
    }],
    ['rejects settings that are not a JSON object', () => {
        assertRejects(() => audioSettings('{'), /PICO_ARGOS_CONFIG is not valid JSON/);
        for (const raw of ['[]', 'null', '18'])
            assertRejects(() => audioSettings(raw), /PICO_ARGOS_CONFIG must be a JSON object/);
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - audio-devices settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - audio-devices settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} audio-devices settings case(s) failed`);
