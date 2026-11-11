// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {DEFAULT_HYSTERESIS_W, DEFAULT_SMOOTHING} from './logic.js';
import {batteryPowerSettings, readBatteryPowerSettings} from './settings.js';

const DEFAULTS = {
    intervalMs: 2_000,
    battery: 'auto',
    smoothing: DEFAULT_SMOOTHING,
    hysteresisWatts: DEFAULT_HYSTERESIS_W,
};

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

function settings(raw) {
    const warnings = [];
    const result = batteryPowerSettings(raw, message => warnings.push(message));
    return {result, warnings};
}

const cases = [
    ['uses the defaults without a warning when the variable is unset', () => {
        const warnings = [];
        const result = withSettingsVariable(null,
            () => readBatteryPowerSettings(message => warnings.push(message)));
        assertEqual(result, {
            intervalMs: 2_000,
            battery: 'auto',
            smoothing: 0.25,
            hysteresisWatts: 0.4,
        }, 'settings');
        assertEqual(warnings, [], 'warnings');
    }],
    ['reads the battery and interval from PICO_ARGOS_CONFIG', () => {
        const warnings = [];
        const result = withSettingsVariable(
            '{"battery":"BAT1","intervalMs":5000,"smoothing":1,"hysteresisWatts":0}',
            () => readBatteryPowerSettings(message => warnings.push(message)));
        assertEqual(result, {
            intervalMs: 5_000,
            battery: 'BAT1',
            smoothing: 1,
            hysteresisWatts: 0,
        }, 'settings');
        assertEqual(warnings, [], 'warnings');
    }],
    ['invalid settings JSON falls back to the defaults with a warning', () => {
        const {result, warnings} = settings('{"battery":');
        assertEqual(result, DEFAULTS, 'settings');
        if (warnings.length !== 1 || !warnings[0].startsWith(
            'Ignoring invalid config.json plugins.battery-power: ' +
            'PICO_ARGOS_CONFIG is not valid JSON'))
            throw new Error(`Unexpected warnings: ${JSON.stringify(warnings)}`);
    }],
    ['settings that are not an object fall back to the defaults with a warning', () => {
        for (const raw of ['[]', 'null', '"BAT0"']) {
            const {result, warnings} = settings(raw);
            assertEqual(result, DEFAULTS, `settings for ${raw}`);
            assertEqual(warnings, [
                'Ignoring invalid config.json plugins.battery-power: ' +
                'PICO_ARGOS_CONFIG must be a JSON object',
            ], `warnings for ${raw}`);
        }
    }],
    ['rejects unknown settings', () => {
        assertRejects(() => settings('{"hysteresisW":1}'),
            /^Unknown setting config\.json plugins\.battery-power\.hysteresisW$/);
    }],
    ['rejects out-of-range values', () => {
        assertRejects(() => settings('{"intervalMs":999}'), /intervalMs must be from 1000 through 30000/);
        assertRejects(() => settings('{"intervalMs":30001}'), /intervalMs/);
        assertRejects(() => settings('{"smoothing":0}'), /smoothing must be above 0 and at most 1/);
        assertRejects(() => settings('{"hysteresisWatts":5.5}'), /hysteresisWatts must be from 0 through 5/);
    }],
    ['rejects a battery name that is not a power-supply name', () => {
        for (const battery of ['../BAT0', '', 1])
            assertRejects(() => settings(JSON.stringify({battery})),
                /battery must be auto or a power-supply name/);
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - battery-power settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - battery-power settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} battery-power settings case(s) failed`);
