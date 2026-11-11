// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {readSystemMonitorSettings, systemMonitorSettings} from './settings.js';

const DEFAULTS = {
    fastIntervalMs: 250,
    diskIntervalMs: 500,
    memoryIntervalMs: 1_000,
    fields: ['cpu', 'gpu', 'memory', 'disk', 'network'],
    gpuDevice: 'auto',
    diskDevice: 'auto',
    networkInterface: 'auto',
    presentation: 'legacy',
    thresholds: {},
    diagnosticTracePath: null,
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
    const result = systemMonitorSettings(raw, message => warnings.push(message));
    return {result, warnings};
}

const cases = [
    ['uses the defaults without a warning when the variable is unset', () => {
        const warnings = [];
        const result = withSettingsVariable(null,
            () => readSystemMonitorSettings(message => warnings.push(message)));
        assertEqual(result, DEFAULTS, 'settings');
        assertEqual(warnings, [], 'warnings');
    }],
    ['reads fields, intervals, and thresholds from PICO_ARGOS_CONFIG', () => {
        const warnings = [];
        const result = withSettingsVariable(JSON.stringify({
            fastIntervalMs: 500,
            fields: ['cpu', 'memory'],
            presentation: 'compact',
            thresholds: {cpu: {warning: 80, critical: 90}, memory: {critical: 97}},
        }), () => readSystemMonitorSettings(message => warnings.push(message)));
        assertEqual(result, {
            ...DEFAULTS,
            fastIntervalMs: 500,
            fields: ['cpu', 'memory'],
            presentation: 'compact',
            thresholds: {cpu: {warning: 80, critical: 90}, memory: {critical: 97}},
        }, 'settings');
        assertEqual(warnings, [], 'warnings');
    }],
    ['invalid settings JSON falls back to the defaults with a warning', () => {
        const {result, warnings} = settings('{"fields": [');
        assertEqual(result, DEFAULTS, 'settings');
        if (warnings.length !== 1 || !warnings[0].startsWith(
            'Ignoring invalid config.json plugins.system-monitor: ' +
            'PICO_ARGOS_CONFIG is not valid JSON'))
            throw new Error(`Unexpected warnings: ${JSON.stringify(warnings)}`);
    }],
    ['settings that are not an object fall back to the defaults with a warning', () => {
        for (const raw of ['[]', 'null', '42', '"cpu"']) {
            const {result, warnings} = settings(raw);
            assertEqual(result, DEFAULTS, `settings for ${raw}`);
            assertEqual(warnings, [
                'Ignoring invalid config.json plugins.system-monitor: ' +
                'PICO_ARGOS_CONFIG must be a JSON object',
            ], `warnings for ${raw}`);
        }
    }],
    ['rejects unknown settings', () => {
        assertRejects(() => settings('{"cpu":true}'),
            /^Unknown setting config\.json plugins\.system-monitor\.cpu$/);
    }],
    ['rejects out-of-range intervals', () => {
        assertRejects(() => settings('{"fastIntervalMs":50}'), /fastIntervalMs must be from 100 through 2000/);
        assertRejects(() => settings('{"diskIntervalMs":10001}'), /diskIntervalMs/);
        assertRejects(() => settings('{"memoryIntervalMs":250.5}'), /memoryIntervalMs/);
    }],
    ['rejects duplicate or unknown fields', () => {
        assertRejects(() => settings('{"fields":["cpu","cpu"]}'), /fields must contain unique/);
        assertRejects(() => settings('{"fields":["swap"]}'), /fields must contain unique/);
        assertRejects(() => settings('{"fields":[]}'), /fields must contain unique/);
    }],
    ['rejects invalid devices and presentation', () => {
        assertRejects(() => settings('{"gpuDevice":"renderD128"}'), /Invalid gpuDevice/);
        assertRejects(() => settings('{"diskDevice":"../sda"}'), /Invalid diskDevice/);
        assertRejects(() => settings('{"networkInterface":""}'), /Invalid networkInterface/);
        assertRejects(() => settings('{"presentation":"wide"}'), /presentation must be legacy or compact/);
    }],
    ['rejects inverted or unknown thresholds', () => {
        assertRejects(() => settings('{"thresholds":{"cpu":{"warning":95,"critical":95}}}'),
            /cpu\.warning must be below cpu\.critical/);
        assertRejects(() => settings('{"thresholds":{"network":{"warning":50}}}'),
            /Invalid threshold field: network/);
        assertRejects(() => settings('{"thresholds":{"cpu":{"warning":0}}}'),
            /cpu\.warning must be from 1 through 100/);
    }],
    ['accepts only an absolute diagnosticTracePath', () => {
        assertRejects(() => settings('{"diagnosticTracePath":"trace.bin"}'),
            /diagnosticTracePath must be null or an absolute path/);
        assertEqual(settings('{"diagnosticTracePath":"/tmp/trace/system.bin"}').result.diagnosticTracePath,
            '/tmp/trace/system.bin', 'trace path');
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - system-monitor settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - system-monitor settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} system-monitor settings case(s) failed`);
