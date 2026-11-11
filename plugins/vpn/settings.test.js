// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {DEFAULT_STATUS_URL, readVpnSettings, vpnSettings} from './settings.js';

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
    ['uses the NordVPN endpoint when the variable is unset', () => {
        assertEqual(withSettingsVariable(null, readVpnSettings),
            {statusUrl: 'https://web-api.nordvpn.com/v1/ips/info'}, 'settings');
        assertEqual(vpnSettings('{}').statusUrl, DEFAULT_STATUS_URL, 'empty object');
    }],
    ['reads statusUrl from PICO_ARGOS_CONFIG', () => {
        const settings = withSettingsVariable(
            '{"statusUrl":"https://status.example/ip"}', readVpnSettings);
        assertEqual(settings, {statusUrl: 'https://status.example/ip'}, 'settings');
    }],
    ['rejects a statusUrl without HTTPS', () => {
        for (const statusUrl of ['http://status.example/ip', '', 7])
            assertRejects(() => vpnSettings(JSON.stringify({statusUrl})),
                /^config\.json plugins\.vpn\.statusUrl must use HTTPS$/);
    }],
    ['rejects unknown settings', () => {
        assertRejects(() => vpnSettings('{"url":"https://status.example/ip"}'),
            /^Unknown setting config\.json plugins\.vpn\.url$/);
    }],
    ['rejects settings that are not a JSON object', () => {
        assertRejects(() => vpnSettings('{'), /PICO_ARGOS_CONFIG is not valid JSON/);
        for (const raw of ['[]', 'null', '"https://status.example/ip"'])
            assertRejects(() => vpnSettings(raw), /PICO_ARGOS_CONFIG must be a JSON object/);
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - vpn settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - vpn settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} vpn settings case(s) failed`);
