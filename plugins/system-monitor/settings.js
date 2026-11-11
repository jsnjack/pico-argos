// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

// pico-argos passes the plugin's object from config.json in this variable.
const SETTINGS_VARIABLE = 'PICO_ARGOS_CONFIG';
const SETTINGS_PATH = 'config.json plugins.system-monitor';
const FIELDS = ['cpu', 'gpu', 'memory', 'disk', 'network'];
const THRESHOLD_FIELDS = ['cpu', 'gpu', 'memory', 'disk'];
const DEFAULTS = Object.freeze({
    fastIntervalMs: 250,
    diskIntervalMs: 500,
    memoryIntervalMs: 1_000,
    fields: FIELDS,
    gpuDevice: 'auto',
    diskDevice: 'auto',
    networkInterface: 'auto',
    presentation: 'legacy',
    thresholds: {},
    diagnosticTracePath: null,
});

/**
 * Reads and validates the plugin's settings from the environment, passing any
 * warning to `warn`.
 */
export function readSystemMonitorSettings(warn) {
    return systemMonitorSettings(GLib.getenv(SETTINGS_VARIABLE), warn);
}

/**
 * Validates one settings document. A missing document, as when the plugin
 * runs by hand, selects the defaults. A document that is not a JSON object is
 * reported through `warn` and also selects the defaults, while an object with
 * an unknown key or an out-of-range value throws.
 */
export function systemMonitorSettings(raw, warn) {
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
    requireRange(result.fastIntervalMs, 100, 2_000, 'fastIntervalMs');
    requireRange(result.diskIntervalMs, 100, 10_000, 'diskIntervalMs');
    requireRange(result.memoryIntervalMs, 100, 10_000, 'memoryIntervalMs');
    if (!Array.isArray(result.fields) || result.fields.length === 0 ||
        result.fields.length > 5 || new Set(result.fields).size !== result.fields.length ||
        result.fields.some(field => !FIELDS.includes(field))) {
        throw new Error('fields must contain unique CPU, GPU, memory, disk, or network names');
    }
    if (typeof result.gpuDevice !== 'string' ||
        !/^(auto|card[0-9]{1,3})$/.test(result.gpuDevice))
        throw new Error('Invalid gpuDevice');
    for (const field of ['diskDevice', 'networkInterface']) {
        if (typeof result[field] !== 'string' || !/^(auto|[A-Za-z0-9_.:-]+)$/.test(result[field]))
            throw new Error(`Invalid ${field}`);
    }
    if (!['legacy', 'compact'].includes(result.presentation))
        throw new Error('presentation must be legacy or compact');
    if (result.diagnosticTracePath !== null &&
        (typeof result.diagnosticTracePath !== 'string' ||
            !GLib.path_is_absolute(result.diagnosticTracePath))) {
        throw new Error('diagnosticTracePath must be null or an absolute path');
    }
    result.thresholds = validateThresholds(result.thresholds);
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

function validateThresholds(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('thresholds must be an object');
    const result = {};
    for (const [field, threshold] of Object.entries(value)) {
        if (!THRESHOLD_FIELDS.includes(field) || threshold === null ||
            typeof threshold !== 'object' || Array.isArray(threshold) ||
            Object.keys(threshold).some(key => !['warning', 'critical'].includes(key))) {
            throw new Error(`Invalid threshold field: ${field}`);
        }
        const normalized = {};
        for (const key of ['warning', 'critical']) {
            if (threshold[key] === undefined)
                continue;
            requireRange(threshold[key], 1, 100, `${field}.${key}`);
            normalized[key] = threshold[key];
        }
        if (normalized.warning !== undefined && normalized.critical !== undefined &&
            normalized.warning >= normalized.critical) {
            throw new Error(`${field}.warning must be below ${field}.critical`);
        }
        result[field] = normalized;
    }
    return result;
}

function requireRange(value, minimum, maximum, name) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
        throw new Error(`${name} must be from ${minimum} through ${maximum}`);
}
