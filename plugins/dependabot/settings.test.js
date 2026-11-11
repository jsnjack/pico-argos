// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {dependabotSettings, readDependabotSettings} from './settings.js';

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
    ['reads the repository from PICO_ARGOS_CONFIG', () => {
        const settings = withSettingsVariable(
            '{"repository":"example/project"}', readDependabotSettings);
        assertEqual(settings, {repository: 'example/project'}, 'settings');
    }],
    ['requires a repository when the variable is unset', () => {
        assertRejects(() => withSettingsVariable(null, readDependabotSettings),
            /^config\.json plugins\.dependabot\.repository is required$/);
    }],
    ['requires a repository in an empty object', () => {
        assertRejects(() => dependabotSettings('{}'), /repository is required/);
    }],
    ['rejects a repository without owner/name form', () => {
        for (const repository of ['project', 'a/b/c', 'a b/c', 42])
            assertRejects(() => dependabotSettings(JSON.stringify({repository})),
                /repository must have owner\/name form/);
    }],
    ['rejects unknown settings, including a token', () => {
        assertRejects(
            () => dependabotSettings('{"repository":"example/project","token":"x"}'),
            /^Unknown setting config\.json plugins\.dependabot\.token$/);
    }],
    ['rejects settings that are not a JSON object', () => {
        assertRejects(() => dependabotSettings('{'), /PICO_ARGOS_CONFIG is not valid JSON/);
        for (const raw of ['[]', 'null', '"example/project"', '7'])
            assertRejects(() => dependabotSettings(raw), /PICO_ARGOS_CONFIG must be a JSON object/);
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - dependabot settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - dependabot settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} dependabot settings case(s) failed`);
