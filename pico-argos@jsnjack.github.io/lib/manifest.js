// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

/** Latest manifest version accepted by this extension release. */
export const MANIFEST_VERSION = 2;
export const LEGACY_MANIFEST_VERSION = 1;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENVIRONMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENVIRONMENT = new Set([
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'PICO_ARGOS_PROTOCOL',
    'PICO_ARGOS_MENU_OPEN',
    'PICO_ARGOS_PLUGIN_ID',
]);
const MODES = new Set(['oneshot', 'stream']);
const POSITIONS = new Set(['left', 'center', 'right']);
const FAILURE_POLICIES = new Set(['keep-last', 'hide', 'show-error']);
const COMMON_KEYS = new Set([
    'manifestVersion',
    'id',
    'mode',
    'command',
    'position',
    'order',
    'nice',
    'reserveTextChars',
    'passEnvironment',
    'failurePolicy',
    'maxStaleMs',
]);
const V2_KEYS = new Set(['protocolVersion']);
const ONESHOT_KEYS = new Set(['intervalMs', 'timeoutMs', 'refreshOnOpen']);
const STREAM_KEYS = new Set([
    'startupTimeoutMs',
    'heartbeatTimeoutMs',
    'maxMessagesPerSecond',
    'maxBytesPerMinute',
]);

/** Describes an invalid plugin manifest. */
export class ManifestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ManifestError';
    }
}

/** Parses and normalizes one plugin manifest. */
export function parseManifest(raw, pluginDirectory, directoryId) {
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new ManifestError(`Invalid manifest JSON: ${error.message}`);
    }
    return validateManifest(value, pluginDirectory, directoryId);
}

/** Validates and normalizes one parsed plugin manifest. */
export function validateManifest(value, pluginDirectory, directoryId) {
    requireObject(value, 'Manifest');
    if (value.manifestVersion !== LEGACY_MANIFEST_VERSION &&
        value.manifestVersion !== MANIFEST_VERSION)
        throw new ManifestError('Manifest version must equal 1 or 2');
    if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id))
        throw new ManifestError('Manifest ID is invalid');
    if (value.id !== directoryId)
        throw new ManifestError('Manifest ID must match its directory name');
    if (!MODES.has(value.mode))
        throw new ManifestError('Manifest mode must be oneshot or stream');

    const allowedKeys = new Set(COMMON_KEYS);
    if (value.manifestVersion === MANIFEST_VERSION) {
        for (const key of V2_KEYS)
            allowedKeys.add(key);
    }
    const modeKeys = value.mode === 'oneshot' ? ONESHOT_KEYS : STREAM_KEYS;
    for (const key of modeKeys)
        allowedKeys.add(key);
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key))
            throw new ManifestError(`Manifest contains unknown or mode-specific field: ${key}`);
    }

    const command = validateCommand(value.command, pluginDirectory);
    if (!POSITIONS.has(value.position))
        throw new ManifestError('Manifest position is invalid');
    requireInteger(value.order, 'Manifest order');

    const nice = value.nice === undefined ? 10 : value.nice;
    if (nice !== null && (!Number.isInteger(nice) || nice < 0 || nice > 19))
        throw new ManifestError('Manifest nice must be null or an integer from 0 through 19');
    const reserveTextChars = value.reserveTextChars ?? 0;
    requireIntegerRange(reserveTextChars, 0, 128, 'Manifest reserveTextChars');
    const passEnvironment = validateEnvironment(value.passEnvironment ?? []);
    if (!FAILURE_POLICIES.has(value.failurePolicy))
        throw new ManifestError('Manifest failurePolicy is invalid');
    const maxStaleMs = validateMaxStale(value.maxStaleMs);
    const protocolVersion = validateProtocolVersion(value);

    const normalized = {
        manifestVersion: value.manifestVersion,
        protocolVersion,
        id: value.id,
        mode: value.mode,
        command,
        position: value.position,
        order: value.order,
        nice,
        reserveTextChars,
        passEnvironment,
        failurePolicy: value.failurePolicy,
        maxStaleMs,
    };

    if (value.mode === 'oneshot')
        Object.assign(normalized, validateOneShot(value, maxStaleMs));
    else
        Object.assign(normalized, validateStream(value));

    Object.freeze(normalized.command);
    Object.freeze(normalized.passEnvironment);
    return Object.freeze(normalized);
}

/** Compares manifests in deterministic panel order. */
export function compareManifests(left, right) {
    const positionOrder = {left: 0, center: 1, right: 2};
    return positionOrder[left.position] - positionOrder[right.position] ||
        left.order - right.order || left.id.localeCompare(right.id);
}

function validateCommand(value, pluginDirectory) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 32)
        throw new ManifestError('Manifest command must contain 1 through 32 argv elements');

    let totalBytes = 0;
    const command = value.map((element, index) => {
        if (typeof element !== 'string')
            throw new ManifestError(`Manifest command element ${index} must be a string`);
        if (element.includes('\0'))
            throw new ManifestError(`Manifest command element ${index} contains NUL`);
        const bytes = new TextEncoder().encode(element).length;
        if (bytes > 4_096)
            throw new ManifestError(`Manifest command element ${index} exceeds 4096 bytes`);
        totalBytes += bytes;
        return element;
    });
    if (command[0].length === 0)
        throw new ManifestError('Manifest executable must not be empty');
    if (totalBytes > 16 * 1_024)
        throw new ManifestError('Manifest command exceeds 16 KiB');

    if (command[0].includes('/')) {
        const root = GLib.canonicalize_filename(pluginDirectory, null);
        const executable = GLib.canonicalize_filename(command[0], root);
        if (executable !== root && !executable.startsWith(`${root}/`))
            throw new ManifestError('Manifest executable escapes its plugin directory');
        command[0] = executable;
    }
    return command;
}

function validateEnvironment(value) {
    if (!Array.isArray(value) || value.length > 16)
        throw new ManifestError('Manifest passEnvironment must contain at most 16 names');
    const unique = new Set();
    for (const name of value) {
        if (typeof name !== 'string' || !ENVIRONMENT_PATTERN.test(name))
            throw new ManifestError(`Manifest environment name is invalid: ${name}`);
        if (RESERVED_ENVIRONMENT.has(name))
            throw new ManifestError(`Manifest environment name is reserved: ${name}`);
        if (unique.has(name))
            throw new ManifestError(`Manifest environment name is duplicated: ${name}`);
        unique.add(name);
    }
    return [...value];
}

function validateMaxStale(value) {
    if (value === null)
        return null;
    requireIntegerRange(value, 1, 604_800_000, 'Manifest maxStaleMs');
    return value;
}

function validateOneShot(value, maxStaleMs) {
    requireIntegerRange(value.intervalMs, 1_000, 86_400_000, 'Manifest intervalMs');
    requireIntegerRange(value.timeoutMs, 100, 30_000, 'Manifest timeoutMs');
    if (value.timeoutMs >= value.intervalMs)
        throw new ManifestError('Manifest timeoutMs must be less than intervalMs');
    if (typeof value.refreshOnOpen !== 'boolean')
        throw new ManifestError('Manifest refreshOnOpen must be boolean');
    if (maxStaleMs !== null && maxStaleMs < value.intervalMs)
        throw new ManifestError('Manifest maxStaleMs must be at least intervalMs');

    return {
        intervalMs: value.intervalMs,
        timeoutMs: value.timeoutMs,
        refreshOnOpen: value.refreshOnOpen,
    };
}

function validateStream(value) {
    const startupTimeoutMs = value.startupTimeoutMs ?? 5_000;
    const heartbeatTimeoutMs = value.heartbeatTimeoutMs ?? 0;
    const maxMessagesPerSecond = value.maxMessagesPerSecond ?? 2;
    const maxBytesPerMinute = value.maxBytesPerMinute ?? 262_144;

    requireIntegerRange(startupTimeoutMs, 100, 30_000, 'Manifest startupTimeoutMs');
    if (heartbeatTimeoutMs !== 0)
        requireIntegerRange(heartbeatTimeoutMs, 1_000, 300_000, 'Manifest heartbeatTimeoutMs');
    requireIntegerRange(maxMessagesPerSecond, 1, 10, 'Manifest maxMessagesPerSecond');
    requireIntegerRange(maxBytesPerMinute, 65_536, 1_048_576, 'Manifest maxBytesPerMinute');
    return {
        startupTimeoutMs,
        heartbeatTimeoutMs,
        maxMessagesPerSecond,
        maxBytesPerMinute,
    };
}

function validateProtocolVersion(value) {
    if (value.manifestVersion === LEGACY_MANIFEST_VERSION)
        return 1;
    if (value.mode !== 'stream')
        throw new ManifestError('Manifest version 2 is only valid for stream plugins');
    if (value.protocolVersion !== 2)
        throw new ManifestError('Manifest protocolVersion must equal 2');
    return value.protocolVersion;
}

function requireObject(value, context) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new ManifestError(`${context} must be an object`);
}

function requireInteger(value, context) {
    if (!Number.isInteger(value))
        throw new ManifestError(`${context} must be an integer`);
}

function requireIntegerRange(value, minimum, maximum, context) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
        throw new ManifestError(`${context} must be from ${minimum} through ${maximum}`);
}
