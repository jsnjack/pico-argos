// SPDX-License-Identifier: GPL-3.0-or-later

export const DEFAULT_CACHE_TTL_MS = 1_800_000;
export const DEFAULT_DETECT_TIMEOUT_MS = 3_000;
export const MAX_CONFIG_BYTES = 64 * 1_024;
export const MAX_CACHE_BYTES = 4 * 1_024;
export const COORDINATE_DECIMALS = 4;

const CONFIG_KEYS = new Set([
    'location',
    'fallback',
    'cacheTtlMs',
    'detectTimeoutMs',
]);
const COORDINATE_KEYS = new Set(['latitude', 'longitude']);
const CACHE_KEYS = new Set(['latitude', 'longitude', 'updatedMs']);

/** Strictly parses the optional weather configuration document. */
export function parseWeatherConfig(value) {
    if (value === undefined || value === null) {
        return Object.freeze({
            location: 'auto',
            fallback: null,
            cacheTtlMs: DEFAULT_CACHE_TTL_MS,
            detectTimeoutMs: DEFAULT_DETECT_TIMEOUT_MS,
        });
    }
    requireObject(value, 'configuration');
    rejectUnknown(value, CONFIG_KEYS, 'configuration');

    const rawLocation = value.location ?? 'auto';
    let location;
    if (rawLocation === 'auto')
        location = 'auto';
    else
        location = parseCoordinates(rawLocation, 'configured location');

    const fallback = value.fallback === undefined || value.fallback === null ?
        null : parseCoordinates(value.fallback, 'fallback location');
    const cacheTtlMs = requireRange(
        value.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 0, 86_400_000, 'cacheTtlMs');
    const detectTimeoutMs = requireRange(
        value.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS, 0, 15_000,
        'detectTimeoutMs');

    return Object.freeze({location, fallback, cacheTtlMs, detectTimeoutMs});
}

/** Validates and rounds one coordinate pair. */
export function parseCoordinates(value, context) {
    requireObject(value, context);
    rejectUnknown(value, COORDINATE_KEYS, context);
    const latitude = value.latitude;
    const longitude = value.longitude;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
        throw new Error(`Weather ${context} latitude is invalid`);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
        throw new Error(`Weather ${context} longitude is invalid`);
    return Object.freeze({
        latitude: round(latitude),
        longitude: round(longitude),
    });
}

/** Parses one cached location, rejecting malformed, future, or stale entries. */
export function parseCachedLocation(value, nowMs, ttlMs) {
    if (value === undefined || value === null)
        return null;
    requireObject(value, 'cached location');
    rejectUnknown(value, CACHE_KEYS, 'cached location');
    const updatedMs = value.updatedMs;
    if (!Number.isFinite(updatedMs) || updatedMs < 0)
        return null;
    const age = nowMs - updatedMs;
    if (age < 0 || age > ttlMs)
        return null;
    const {latitude, longitude} = value;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return null;
    try {
        return parseCoordinates({latitude, longitude}, 'cached location');
    } catch {
        return null;
    }
}

/** Builds one cached location document for the given coordinates. */
export function cacheDocument(coordinates, nowMs) {
    return {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        updatedMs: nowMs,
    };
}

/**
 * Chooses coordinates from the configured, detected, and cached sources.
 * A null result requests the service default, preserving legacy behavior.
 */
export function resolveLocation({config, detected = null, cached = null}) {
    if (config.location !== 'auto')
        return Object.freeze({coordinates: config.location, source: 'configured'});
    if (detected !== null)
        return Object.freeze({coordinates: detected, source: 'detected'});
    if (cached !== null)
        return Object.freeze({coordinates: cached, source: 'cached'});
    if (config.fallback !== null)
        return Object.freeze({coordinates: config.fallback, source: 'fallback'});
    return Object.freeze({coordinates: null, source: 'service-default'});
}

/** Builds the bounded glance request URI for one optional coordinate pair. */
export function glanceUri(base, coordinates) {
    if (typeof base !== 'string' || !base.startsWith('https://'))
        throw new Error('Weather source URI is invalid');
    if (coordinates === null)
        return base;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}lat=${coordinates.latitude}` +
        `&lon=${coordinates.longitude}`;
}

function round(value) {
    const factor = 10 ** COORDINATE_DECIMALS;
    return Math.round(value * factor) / factor;
}

function requireRange(value, minimum, maximum, context) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
        throw new Error(`Weather ${context} is invalid`);
    return value;
}

function requireObject(value, context) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`Weather ${context} must be an object`);
}

function rejectUnknown(value, allowed, context) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error(`Weather ${context} has unknown key ${key}`);
    }
}
