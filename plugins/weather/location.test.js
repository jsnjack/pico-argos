// SPDX-License-Identifier: GPL-3.0-or-later

import {
    cacheDocument,
    DEFAULT_CACHE_TTL_MS,
    DEFAULT_DETECT_TIMEOUT_MS,
    glanceUri,
    parseCachedLocation,
    parseCoordinates,
    parseGnomeLocations,
    parseWeatherConfig,
    resolveLocation,
} from './location.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: ${JSON.stringify(actual)}`);
}

function assertInvalid(callback, pattern) {
    try {
        callback();
    } catch (error) {
        if (!pattern.test(error.message))
            throw new Error(`Unexpected rejection: ${error.message}`);
        return;
    }
    throw new Error('Invalid weather location input was accepted');
}

const SOURCE = 'https://weather.yauhen.cc/api/v1/glance';

// An absent configuration keeps the legacy service-default behavior.
const defaults = parseWeatherConfig(undefined);
assertEqual(defaults, {
    location: 'auto',
    fallback: null,
    cacheTtlMs: DEFAULT_CACHE_TTL_MS,
    detectTimeoutMs: DEFAULT_DETECT_TIMEOUT_MS,
    useGnomeLocation: true,
}, 'default weather configuration');
assertEqual(
    glanceUri(SOURCE, resolveLocation({config: defaults}).coordinates),
    SOURCE,
    'absent location leaves the legacy request untouched');
assertEqual(
    resolveLocation({config: defaults}).source,
    'service-default',
    'absent location reports the service default');

// Coordinates are validated and rounded to a bounded precision.
assertEqual(
    parseCoordinates({latitude: 53.900_611_1, longitude: 27.558_972_2}, 'test'),
    {latitude: 53.9006, longitude: 27.559},
    'coordinates are rounded');
assertInvalid(() => parseCoordinates({latitude: 91, longitude: 0}, 'test'), /latitude/);
assertInvalid(() => parseCoordinates({latitude: 0, longitude: 181}, 'test'), /longitude/);
assertInvalid(() => parseCoordinates({latitude: 0}, 'test'), /longitude/);
assertInvalid(
    () => parseCoordinates({latitude: 0, longitude: 0, typo: 1}, 'test'),
    /unknown key/);
assertInvalid(() => parseWeatherConfig({typo: true}), /unknown key/);
assertInvalid(() => parseWeatherConfig({location: 'home'}), /must be an object/);
assertInvalid(() => parseWeatherConfig({detectTimeoutMs: 60_000}), /detectTimeoutMs/);

// An explicit configured location wins over every detected source.
const fixed = parseWeatherConfig({
    location: {latitude: 41.3874, longitude: 2.1686},
    fallback: {latitude: 52.3555, longitude: 5.0003},
});
const configured = resolveLocation({
    config: fixed,
    detected: {latitude: 1, longitude: 1},
    cached: {latitude: 2, longitude: 2},
});
assertEqual(configured, {
    coordinates: {latitude: 41.3874, longitude: 2.1686},
    source: 'configured',
}, 'configured location wins');
assertEqual(
    glanceUri(SOURCE, configured.coordinates),
    `${SOURCE}?lat=41.3874&lon=2.1686`,
    'coordinates are appended to the legacy endpoint');

// Automatic resolution prefers a detection, then the cache, then the fallback.
const auto = parseWeatherConfig({
    fallback: {latitude: 52.3555, longitude: 5.0003},
});
assertEqual(resolveLocation({
    config: auto,
    detected: {latitude: 53.9006, longitude: 27.559},
    cached: {latitude: 2, longitude: 2},
}), {
    coordinates: {latitude: 53.9006, longitude: 27.559},
    source: 'detected',
}, 'a detection wins over the cache');
assertEqual(resolveLocation({
    config: auto,
    cached: {latitude: 53.9006, longitude: 27.559},
}), {
    coordinates: {latitude: 53.9006, longitude: 27.559},
    source: 'cached',
}, 'the cache wins over the fallback');
assertEqual(resolveLocation({config: auto}), {
    coordinates: {latitude: 52.3555, longitude: 5.0003},
    source: 'fallback',
}, 'the fallback covers a failed detection');

// A cached location expires, rejects clock skew, and rejects malformed input.
const now = 1_000_000;
const fresh = cacheDocument({latitude: 53.9006, longitude: 27.559}, now - 60_000);
assertEqual(
    parseCachedLocation(fresh, now, DEFAULT_CACHE_TTL_MS),
    {latitude: 53.9006, longitude: 27.559},
    'a fresh cache entry is accepted');
assertEqual(
    parseCachedLocation(fresh, now, 30_000),
    null,
    'a stale cache entry is rejected');
assertEqual(
    parseCachedLocation(cacheDocument({latitude: 1, longitude: 1}, now + 60_000),
        now, DEFAULT_CACHE_TTL_MS),
    null,
    'a future cache entry is rejected');
assertEqual(
    parseCachedLocation({latitude: 'x', longitude: 1, updatedMs: now}, now,
        DEFAULT_CACHE_TTL_MS),
    null,
    'a malformed cache entry is rejected');
assertEqual(parseCachedLocation(null, now, DEFAULT_CACHE_TTL_MS), null,
    'an absent cache is rejected');

// GNOME stores one serialized GWeatherLocation with radian coordinates.
const gnomeAmsterdam = [
    [2, ['Amsterdam', 'EHAM', false,
        [[0.912_807_198_793_034_18, 0.083_194_033_496_160_544]],
        [[0.912_807_198_793_034_18, 0.083_194_033_496_160_544]]]],
];
assertEqual(
    parseGnomeLocations(gnomeAmsterdam),
    {latitude: 52.3, longitude: 4.7667},
    'GNOME radian coordinates are converted to degrees');
for (const malformed of [
    null, [], 'x', [[]], [[2]], [[2, ['Name', 'CODE', false]]],
    [[2, ['Name', 'CODE', false, []]]],
    [[2, ['Name', 'CODE', false, [[0.1]]]]],
    [[2, ['Name', 'CODE', false, [['x', 'y']]]]],
    [[2, ['Name', 'CODE', false, [[99, 0]]]]],
])
    assertEqual(parseGnomeLocations(malformed), null,
        `malformed GNOME location is ignored: ${JSON.stringify(malformed)}`);

// A pinned GNOME city outranks detection, the cache, and the fallback.
assertEqual(resolveLocation({
    config: auto,
    gnome: {latitude: 53.9006, longitude: 27.559},
    detected: {latitude: 1, longitude: 1},
    cached: {latitude: 2, longitude: 2},
}), {
    coordinates: {latitude: 53.9006, longitude: 27.559},
    source: 'gnome-weather',
}, 'a pinned GNOME city wins over detection');
assertEqual(resolveLocation({
    config: fixed,
    gnome: {latitude: 53.9006, longitude: 27.559},
}).source, 'configured', 'an explicit override still outranks GNOME');
assertEqual(
    parseWeatherConfig({useGnomeLocation: false}).useGnomeLocation,
    false,
    'the GNOME source is opt-out');
assertInvalid(() => parseWeatherConfig({useGnomeLocation: 'yes'}), /boolean/);

assertInvalid(() => glanceUri('http://weather.example', null), /source URI/);

print('ok - weather location resolves through configuration, detection, and cache');
