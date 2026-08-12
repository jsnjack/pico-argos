#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {weatherSnapshot} from './logic.js';
import {
    cacheDocument,
    glanceUri,
    MAX_CACHE_BYTES,
    MAX_CONFIG_BYTES,
    parseCachedLocation,
    parseGnomeLocations,
    parseWeatherConfig,
    resolveLocation,
} from './location.js';

const WEATHER_SOURCE = 'https://weather.yauhen.cc/api/v1/glance';
const GEOCLUE_NAME = 'org.freedesktop.GeoClue2';
const MANAGER_PATH = '/org/freedesktop/GeoClue2/Manager';
const MANAGER_INTERFACE = 'org.freedesktop.GeoClue2.Manager';
const CLIENT_INTERFACE = 'org.freedesktop.GeoClue2.Client';
const LOCATION_INTERFACE = 'org.freedesktop.GeoClue2.Location';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const ACCURACY_LEVEL_CITY = 4;
const DESKTOP_ID = 'pico-argos-weather';
const GNOME_WEATHER_SCHEMA = 'org.gnome.shell.weather';

try {
    const config = loadConfiguration();
    const nowMs = Date.now();
    let gnome = null;
    let cached = null;
    let detected = null;
    if (config.location === 'auto') {
        gnome = config.useGnomeLocation ? readGnomeLocation() : null;
        if (gnome === null) {
            cached = loadCachedLocation(config, nowMs);
            if (cached === null) {
                detected = await detectLocation(config.detectTimeoutMs);
                if (detected !== null)
                    storeCachedLocation(detected, nowMs);
            }
        }
    }
    const resolved = resolveLocation({config, gnome, detected, cached});

    const message = Soup.Message.new(
        'GET', glanceUri(WEATHER_SOURCE, resolved.coordinates));
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('User-Agent', 'argos-weather/1.0');
    const bytes = readBoundedResponse(
        new Soup.Session({timeout: 15}), message, 1_048_576);
    if (message.status_code < 200 || message.status_code >= 300)
        throw new Error(`Weather service returned HTTP ${message.status_code}`);
    const data = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    print(JSON.stringify(weatherSnapshot(data)));
} catch (error) {
    printerr(`[weather] ${error.message}`);
    System.exit(1);
}

/**
 * Reads the city pinned in GNOME Weather. A location is only meaningful here
 * when the user turned automatic detection off, because otherwise the value is
 * whatever the location service last reported and carries nothing new.
 */
function readGnomeLocation() {
    try {
        const schema = Gio.SettingsSchemaSource.get_default()
            ?.lookup(GNOME_WEATHER_SCHEMA, true);
        if (!schema || !schema.has_key('locations') ||
            !schema.has_key('automatic-location'))
            return null;
        const settings = new Gio.Settings({settings_schema: schema});
        if (settings.get_boolean('automatic-location'))
            return null;
        return parseGnomeLocations(
            settings.get_value('locations').recursiveUnpack());
    } catch {
        return null;
    }
}

/**
 * Resolves coordinates through GeoClue within a hard deadline. Detection is
 * best-effort: an unavailable, unauthorized, or unresponsive service yields
 * null so the caller falls back instead of delaying the panel.
 */
async function detectLocation(timeoutMs) {
    if (timeoutMs === 0)
        return null;
    const cancellable = new Gio.Cancellable();
    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timeoutId = 0;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    let clientPath = null;
    let signalId = 0;
    try {
        [clientPath] = (await busCall(
            MANAGER_PATH, MANAGER_INTERFACE, 'GetClient', null, cancellable))
            .deepUnpack();
        await setClientProperty(
            clientPath, 'DesktopId', GLib.Variant.new_string(DESKTOP_ID),
            cancellable);
        await setClientProperty(
            clientPath, 'RequestedAccuracyLevel',
            GLib.Variant.new_uint32(ACCURACY_LEVEL_CITY), cancellable);

        const updated = new Promise(resolve => {
            signalId = Gio.DBus.system.signal_subscribe(
                GEOCLUE_NAME, CLIENT_INTERFACE, 'LocationUpdated', clientPath,
                null, Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _interface, _signal, parameters) =>
                    resolve(parameters.deepUnpack()[1]));
        });
        await busCall(clientPath, CLIENT_INTERFACE, 'Start', null, cancellable);

        const current = await readProperty(
            clientPath, CLIENT_INTERFACE, 'Location', cancellable);
        const path = current !== null && current !== '/' ?
            current : await Promise.race([updated, whenCancelled(cancellable)]);
        if (path === null || path === '/')
            return null;
        const latitude = await readProperty(
            path, LOCATION_INTERFACE, 'Latitude', cancellable);
        const longitude = await readProperty(
            path, LOCATION_INTERFACE, 'Longitude', cancellable);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
            return null;
        return {latitude, longitude};
    } catch {
        return null;
    } finally {
        if (signalId !== 0)
            Gio.DBus.system.signal_unsubscribe(signalId);
        if (timeoutId !== 0)
            GLib.source_remove(timeoutId);
        releaseClient(clientPath);
    }
}

function busCall(path, interfaceName, method, parameters, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            GEOCLUE_NAME, path, interfaceName, method, parameters, null,
            Gio.DBusCallFlags.NONE, -1, cancellable,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function setClientProperty(path, name, value, cancellable) {
    return busCall(
        path, PROPERTIES_INTERFACE, 'Set',
        new GLib.Variant('(ssv)', [CLIENT_INTERFACE, name, value]), cancellable);
}

async function readProperty(path, interfaceName, name, cancellable) {
    try {
        const reply = await busCall(
            path, PROPERTIES_INTERFACE, 'Get',
            new GLib.Variant('(ss)', [interfaceName, name]), cancellable);
        return reply.recursiveUnpack()[0];
    } catch {
        return null;
    }
}

function whenCancelled(cancellable) {
    return new Promise(resolve => {
        if (cancellable.is_cancelled()) {
            resolve(null);
            return;
        }
        cancellable.connect(() => resolve(null));
    });
}

/** Best-effort release so GeoClue drops the in-use marker promptly. */
function releaseClient(clientPath) {
    if (clientPath === null)
        return;
    try {
        Gio.DBus.system.call(
            GEOCLUE_NAME, clientPath, CLIENT_INTERFACE, 'Stop', null, null,
            Gio.DBusCallFlags.NONE, 1_000, null, null);
    } catch {
        // The connection closes on exit, which releases the client anyway.
    }
}

function loadConfiguration() {
    const value = readBoundedJson(GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'pico-argos',
        'weather.json',
    ]), MAX_CONFIG_BYTES, 'configuration');
    return parseWeatherConfig(value ?? undefined);
}

function loadCachedLocation(config, nowMs) {
    if (config.cacheTtlMs === 0)
        return null;
    try {
        return parseCachedLocation(
            readBoundedJson(cachePath(), MAX_CACHE_BYTES, 'location cache'),
            nowMs, config.cacheTtlMs);
    } catch {
        return null;
    }
}

function storeCachedLocation(coordinates, nowMs) {
    try {
        const file = Gio.File.new_for_path(cachePath());
        const parent = file.get_parent();
        if (parent !== null && !parent.query_exists(null))
            parent.make_directory_with_parents(null);
        file.replace_contents(
            new TextEncoder().encode(
                JSON.stringify(cacheDocument(coordinates, nowMs))),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (error) {
        // A cache miss only costs one detection, so never fail the snapshot.
        printerr(`[weather] caching location failed: ${error.message}`);
    }
}

function cachePath() {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'pico-argos',
        'weather-location.json',
    ]);
}

function readBoundedJson(path, maximumBytes, context) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    const [ok, bytes] = file.load_contents(null);
    if (!ok)
        throw new Error(`Reading weather ${context} failed`);
    const data = new Uint8Array(bytes);
    if (data.length > maximumBytes)
        throw new Error(`Weather ${context} exceeds ${maximumBytes} bytes`);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data));
}

function readBoundedResponse(session, message, maximumBytes) {
    const stream = session.send(message, null);
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const requestBytes = Math.min(64 * 1_024, maximumBytes + 1 - length);
            const block = stream.read_bytes(requestBytes, null);
            const chunk = new Uint8Array(block.get_data());
            if (chunk.length === 0)
                break;
            length += chunk.length;
            if (length > maximumBytes)
                throw new Error('Weather response exceeds 1 MiB');
            chunks.push(chunk);
        }
    } finally {
        stream.close(null);
    }
    return joinChunks(chunks, length);
}

function joinChunks(chunks, length) {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}
