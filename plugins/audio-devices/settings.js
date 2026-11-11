// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {parseAudioConfig} from './logic.js';

// pico-argos passes the plugin's object from config.json in this variable.
const SETTINGS_VARIABLE = 'PICO_ARGOS_CONFIG';

/** Reads and validates the plugin's settings from the environment. */
export function readAudioSettings() {
    return audioSettings(GLib.getenv(SETTINGS_VARIABLE));
}

/**
 * Strictly validates one settings document, or null when the variable is
 * unset, as when the plugin runs by hand.
 */
export function audioSettings(raw) {
    return parseAudioConfig(parseSettings(raw));
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
