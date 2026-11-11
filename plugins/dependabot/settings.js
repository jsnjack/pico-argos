// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

// pico-argos passes the plugin's object from config.json in this variable.
const SETTINGS_VARIABLE = 'PICO_ARGOS_CONFIG';
const SETTINGS_PATH = 'config.json plugins.dependabot';
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEYS = new Set(['repository']);

/** Reads and validates the plugin's settings from the environment. */
export function readDependabotSettings() {
    return dependabotSettings(GLib.getenv(SETTINGS_VARIABLE));
}

/**
 * Strictly validates one settings document, or null when the variable is
 * unset. `repository` is required.
 */
export function dependabotSettings(raw) {
    const value = parseSettings(raw);
    const unknown = Object.keys(value).find(key => !KEYS.has(key));
    if (unknown !== undefined)
        throw new Error(`Unknown setting ${SETTINGS_PATH}.${unknown}`);
    if (value.repository === undefined)
        throw new Error(`${SETTINGS_PATH}.repository is required`);
    if (typeof value.repository !== 'string' ||
        !REPOSITORY_PATTERN.test(value.repository))
        throw new Error(`${SETTINGS_PATH}.repository must have owner/name form`);
    return Object.freeze({repository: value.repository});
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
