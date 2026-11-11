// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

// pico-argos passes the plugin's object from config.json in this variable.
const SETTINGS_VARIABLE = 'PICO_ARGOS_CONFIG';
const SETTINGS_PATH = 'config.json plugins.vpn';

/** The original NordVPN public status endpoint. */
export const DEFAULT_STATUS_URL = 'https://web-api.nordvpn.com/v1/ips/info';

const KEYS = new Set(['statusUrl']);

/** Reads and validates the plugin's settings from the environment. */
export function readVpnSettings() {
    return vpnSettings(GLib.getenv(SETTINGS_VARIABLE));
}

/**
 * Strictly validates one settings document, or null when the variable is
 * unset, as when the plugin runs by hand.
 */
export function vpnSettings(raw) {
    const value = parseSettings(raw);
    const unknown = Object.keys(value).find(key => !KEYS.has(key));
    if (unknown !== undefined)
        throw new Error(`Unknown setting ${SETTINGS_PATH}.${unknown}`);
    const statusUrl = value.statusUrl ?? DEFAULT_STATUS_URL;
    if (typeof statusUrl !== 'string' || !statusUrl.startsWith('https://'))
        throw new Error(`${SETTINGS_PATH}.statusUrl must use HTTPS`);
    return Object.freeze({statusUrl});
}

function parseSettings(raw) {
    if (raw === null)
        return {};
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${SETTINGS_VARIABLE} is not valid JSON: ${error.message}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${SETTINGS_VARIABLE} must be a JSON object`);
    return value;
}
