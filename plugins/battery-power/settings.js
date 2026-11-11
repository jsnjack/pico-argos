// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {
    DEFAULT_HYSTERESIS_W,
    DEFAULT_SMOOTHING,
    SUPPLY_NAME_PATTERN,
} from './logic.js';

// pico-argos passes the plugin's object from config.json in this variable.
const SETTINGS_VARIABLE = 'PICO_ARGOS_CONFIG';
const SETTINGS_PATH = 'config.json plugins.battery-power';
const DEFAULTS = Object.freeze({
    intervalMs: 2_000,
    battery: 'auto',
    smoothing: DEFAULT_SMOOTHING,
    hysteresisWatts: DEFAULT_HYSTERESIS_W,
});

/**
 * Reads and validates the plugin's settings from the environment, passing any
 * warning to `warn`.
 */
export function readBatteryPowerSettings(warn) {
    return batteryPowerSettings(GLib.getenv(SETTINGS_VARIABLE), warn);
}

/**
 * Validates one settings document. A missing document, as when the plugin
 * runs by hand, selects the defaults. A document that is not a JSON object is
 * reported through `warn` and also selects the defaults, while an object with
 * an unknown key or an out-of-range value throws.
 */
export function batteryPowerSettings(raw, warn) {
    let value = {};
    try {
        value = parseSettings(raw);
    } catch (error) {
        warn(`Ignoring invalid ${SETTINGS_PATH}: ${error.message}`);
    }
    const unknown = Object.keys(value).find(key => !Object.hasOwn(DEFAULTS, key));
    if (unknown !== undefined)
        throw new Error(`Unknown setting ${SETTINGS_PATH}.${unknown}`);
    const result = {...DEFAULTS, ...value};
    // The ceiling keeps the emission gap inside the manifest's heartbeat
    // deadline, which the freshness repeat is what satisfies.
    if (!Number.isInteger(result.intervalMs) ||
        result.intervalMs < 1_000 || result.intervalMs > 30_000)
        throw new Error('intervalMs must be from 1000 through 30000');
    if (typeof result.battery !== 'string' ||
        (result.battery !== 'auto' && !SUPPLY_NAME_PATTERN.test(result.battery)))
        throw new Error('battery must be auto or a power-supply name');
    if (!Number.isFinite(result.smoothing) ||
        result.smoothing <= 0 || result.smoothing > 1)
        throw new Error('smoothing must be above 0 and at most 1');
    if (!Number.isFinite(result.hysteresisWatts) ||
        result.hysteresisWatts < 0 || result.hysteresisWatts > 5)
        throw new Error('hysteresisWatts must be from 0 through 5');
    return result;
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
