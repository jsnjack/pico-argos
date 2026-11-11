// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {parseWeatherConfig} from './location.js';
import {readWeatherSettings, weatherSettings} from './settings.js';

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
        assertEqual(withSettingsVariable(null, readWeatherSettings),
            parseWeatherConfig(undefined), 'settings');
        assertEqual(weatherSettings('{}'), parseWeatherConfig(undefined), 'empty object');
    }],
    ['reads the location mode from PICO_ARGOS_CONFIG', () => {
        const settings = withSettingsVariable(
            '{"location":"ip","cacheTtlMs":0,"useGnomeLocation":false}',
            readWeatherSettings);
        assertEqual(settings, {
            location: 'ip',
            fallback: null,
            cacheTtlMs: 0,
            detectTimeoutMs: 3_000,
            useGnomeLocation: false,
        }, 'settings');
    }],
    ['reads pinned and fallback coordinates as nested objects', () => {
        const settings = weatherSettings(JSON.stringify({
            location: {latitude: 52.370216, longitude: 4.895168},
            fallback: {latitude: 51.9244, longitude: 4.4777},
        }));
        assertEqual(settings.location, {latitude: 52.3702, longitude: 4.8952}, 'location');
        assertEqual(settings.fallback, {latitude: 51.9244, longitude: 4.4777}, 'fallback');
    }],
    ['rejects unknown or invalid settings', () => {
        assertRejects(() => weatherSettings('{"typo":true}'), /unknown key typo/);
        assertRejects(() => weatherSettings('{"location":"home"}'), /must be an object/);
        assertRejects(() => weatherSettings('{"detectTimeoutMs":60000}'), /detectTimeoutMs/);
    }],
    ['rejects settings that are not a JSON object', () => {
        assertRejects(() => weatherSettings('{'), /PICO_ARGOS_CONFIG is not valid JSON/);
        for (const raw of ['[]', 'null', '"ip"'])
            assertRejects(() => weatherSettings(raw), /PICO_ARGOS_CONFIG must be a JSON object/);
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - weather settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - weather settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} weather settings case(s) failed`);
