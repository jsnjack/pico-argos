// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {PLUGIN_POSITIONS} from './manifest.js';

/** Name of the single user configuration file below the pico-argos directory. */
export const CONFIG_FILE_NAME = 'config.json';
export const MAX_CONFIG_BYTES = 64 * 1_024;

const MAX_CONFIGURED_PLUGINS = 64;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIAGNOSTICS_MODES = new Set(['summary', 'off']);
const TOP_LEVEL_KEYS = new Set(['extension', 'plugins']);
const EXTENSION_KEYS = new Set(['diagnosticsMode', 'explicitPanelRedraw']);
/** Keys of a plugin's object that the extension reads instead of the plugin. */
const EXTENSION_PLUGIN_KEYS = new Set(['enabled', 'position', 'order']);

/** Describes an invalid config.json. */
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

/** Returns the absolute path of the user's config.json. */
export function configPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'pico-argos',
        CONFIG_FILE_NAME,
    ]);
}

/**
 * Parses config.json text into extension preferences and per-plugin entries.
 * Whitespace-only text is the empty configuration.
 */
export function parseConfig(text) {
    return validateConfig(parseDocument(text));
}

/** Validates one parsed config.json document. */
export function validateConfig(value) {
    requireObject(value, 'config.json');
    rejectUnknown(value, TOP_LEVEL_KEYS, 'config.json');

    const extension = value.extension ?? {};
    requireObject(extension, '"extension"');
    rejectUnknown(extension, EXTENSION_KEYS, '"extension"');
    const diagnosticsMode = extension.diagnosticsMode ?? 'summary';
    if (!DIAGNOSTICS_MODES.has(diagnosticsMode))
        throw new ConfigError('"extension.diagnosticsMode" must be "summary" or "off"');
    const explicitPanelRedraw = extension.explicitPanelRedraw ?? true;
    if (typeof explicitPanelRedraw !== 'boolean')
        throw new ConfigError('"extension.explicitPanelRedraw" must be true or false');

    const pluginObjects = value.plugins ?? {};
    requireObject(pluginObjects, '"plugins"');
    const ids = Object.keys(pluginObjects).sort();
    if (ids.length > MAX_CONFIGURED_PLUGINS)
        throw new ConfigError(`"plugins" has more than ${MAX_CONFIGURED_PLUGINS} entries`);
    const plugins = new Map();
    for (const id of ids) {
        if (!PLUGIN_ID_PATTERN.test(id))
            throw new ConfigError(`"plugins" key "${id}" is not a valid plugin id`);
        plugins.set(id, validatePluginEntry(id, pluginObjects[id]));
    }
    return Object.freeze({
        extension: Object.freeze({diagnosticsMode, explicitPanelRedraw}),
        plugins,
    });
}

export const DEFAULT_CONFIG = validateConfig({});

/** Returns whether the configuration lets one discovered plugin run. */
export function isPluginEnabled(config, pluginId) {
    return config.plugins.get(pluginId)?.enabled ?? true;
}

/**
 * Applies a plugin's config.json entry to its validated discovered record:
 * placement overrides the manifest, and the remaining keys become the
 * settings JSON the plugin receives in PICO_ARGOS_CONFIG.
 */
export function configurePlugin(plugin, entry = null) {
    return Object.freeze({
        ...plugin,
        manifest: Object.freeze({
            ...plugin.manifest,
            position: entry?.position ?? plugin.manifest.position,
            order: entry?.order ?? plugin.manifest.order,
            settingsJson: entry?.settingsJson ?? '{}',
        }),
    });
}

/**
 * Returns config.json text with the value at `path` replaced, keeping every
 * other key and its order. Throws ConfigError when the current text or the
 * result is invalid, so a broken file is never overwritten.
 */
export function updateConfigText(text, path, value) {
    const document = parseDocument(text);
    validateConfig(document);
    let target = document;
    for (const key of path.slice(0, -1)) {
        if (!Object.hasOwn(target, key))
            target[key] = {};
        target = target[key];
        requireObject(target, `"${path.join('.')}"`);
    }
    target[path.at(-1)] = value;
    const next = `${JSON.stringify(document, null, 2)}\n`;
    validateConfig(JSON.parse(next));
    return next;
}

function parseDocument(text) {
    if (text.trim() === '')
        return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new ConfigError(`config.json is not valid JSON: ${error.message}`);
    }
}

function validatePluginEntry(id, value) {
    const context = `"plugins.${id}"`;
    requireObject(value, context);
    const enabled = value.enabled ?? true;
    if (typeof enabled !== 'boolean')
        throw new ConfigError(`${context}.enabled must be true or false`);
    const position = value.position ?? null;
    if (position !== null && !PLUGIN_POSITIONS.has(position))
        throw new ConfigError(`${context}.position must be one of ${[...PLUGIN_POSITIONS].join(', ')}`);
    const order = value.order ?? null;
    if (order !== null && !Number.isInteger(order))
        throw new ConfigError(`${context}.order must be an integer`);
    const settings = Object.fromEntries(Object.entries(value)
        .filter(([key]) => !EXTENSION_PLUGIN_KEYS.has(key)));
    return Object.freeze({
        enabled,
        position,
        order,
        settingsJson: JSON.stringify(settings),
    });
}

function requireObject(value, context) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new ConfigError(`${context} must be a JSON object`);
}

function rejectUnknown(value, allowed, context) {
    const unknown = Object.keys(value).find(key => !allowed.has(key));
    if (unknown !== undefined)
        throw new ConfigError(`${context} has unknown key "${unknown}"`);
}
