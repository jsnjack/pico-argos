#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

// One bounded persistent stream of the battery's power flow. The source is
// the kernel power-supply class. Each cycle reads one `uevent` attribute per
// supply, which is a single embedded-controller round trip instead of one per
// value, and hands the parsed values to the pure logic module.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import {
    DEFAULT_HYSTERESIS_W,
    DEFAULT_SMOOTHING,
    PowerDisplay,
    batterySnapshot,
    parseUevent,
    readingFromUevent,
} from './logic.js';

const SUPPLY_ROOT = '/sys/class/power_supply';
const MAX_UEVENT_BYTES = 16 * 1_024;
const READ_BLOCK_BYTES = 4 * 1_024;
const MAX_SUPPLIES = 32;
const MAX_SOURCES = 8;
const RESOLVE_RETRY_MS = 30_000;
const SLOW_ATTRIBUTE_INTERVAL_MS = 15_000;
const FRESHNESS_INTERVAL_MS = 15_000;
const FAILURES_BEFORE_HIDING = 3;
const HIDDEN_SNAPSHOT = '{"version":1,"type":"snapshot","panel":null,"menu":[]}';
const SUPPLY_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** One attribute file kept open, re-read from its start on every cycle. */
class StableReader {
    constructor(path) {
        this.path = path;
        this._stream = null;
    }

    read() {
        try {
            this._stream ??= Gio.File.new_for_path(this.path).read(null);
            this._stream.seek(0, GLib.SeekType.SET, null);
            return readBoundedStream(this._stream, this.path);
        } catch (error) {
            this.close();
            throw error;
        }
    }

    close() {
        try {
            this._stream?.close(null);
        } catch (_error) {
            // Reopening on the next cycle is the recovery path.
        }
        this._stream = null;
    }
}

const config = loadConfig();
const output = GioUnix.OutputStream.new(1, false);
const encoder = new TextEncoder();
const display = new PowerDisplay({
    smoothing: config.smoothing,
    hysteresisW: config.hysteresisWatts,
});
const mainLoop = new GLib.MainLoop(null, false);

let battery = null;
let batteryDirectory = null;
let mains = null;
let sourceNames = [];
let slow = {sources: [], chargeTypes: null, chargeLimit: null};
let slowRefreshedUs = 0;
let nextResolveUs = 0;
let lastFlowKey = null;
let failures = 0;
let lastRaw = null;
let lastEmitUs = 0;

resolveSupplies(GLib.get_monotonic_time());
if (battery === null)
    printerr('[battery-power] No system battery found; the panel stays hidden');
sample();
const sourceId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    config.intervalMs,
    () => {
        sample();
        return GLib.SOURCE_CONTINUE;
    });
try {
    mainLoop.run();
} finally {
    GLib.source_remove(sourceId);
    closeSupplies();
}

function sample() {
    const nowUs = GLib.get_monotonic_time();
    if (battery === null) {
        if (nowUs >= nextResolveUs)
            resolveSupplies(nowUs);
        if (battery === null) {
            emit(HIDDEN_SNAPSHOT, nowUs);
            return;
        }
    }

    let reading;
    try {
        reading = read(nowUs);
    } catch (error) {
        failures++;
        if (failures >= FAILURES_BEFORE_HIDING) {
            printerr(`[battery-power] ${error.message}`);
            forgetBattery(nowUs);
            emit(HIDDEN_SNAPSHOT, nowUs);
        }
        return;
    }
    failures = 0;
    const watts = display.update(reading.powerW);
    emit(JSON.stringify(batterySnapshot({...reading, powerW: watts})), nowUs);
}

function read(nowUs) {
    const values = parseUevent(battery.read());
    if (values.size === 0)
        throw new Error(`Battery ${battery.path} reported no attributes`);
    let mainsValues = null;
    if (mains !== null) {
        try {
            mainsValues = parseUevent(mains.read());
        } catch (error) {
            printerr('[battery-power] Reading the adapter stopped working: ' +
                error.message);
            mains.close();
            mains = null;
        }
    }

    // A charge that starts, stops, or turns around is a new series: the
    // average from the old direction would only slow the panel down, and the
    // adapter and charging policy are worth re-reading at that moment.
    const flowKey = `${values.get('POWER_SUPPLY_STATUS')}` +
        `/${mainsValues?.get('POWER_SUPPLY_ONLINE')}`;
    if (flowKey !== lastFlowKey) {
        display.reset();
        lastFlowKey = flowKey;
        refreshSlowAttributes(nowUs);
    } else if (nowUs - slowRefreshedUs >= SLOW_ATTRIBUTE_INTERVAL_MS * 1_000) {
        refreshSlowAttributes(nowUs);
    }

    return readingFromUevent(values, {
        mains: mainsValues,
        sources: slow.sources,
        chargeTypes: slow.chargeTypes,
        chargeLimit: slow.chargeLimit,
    });
}

/**
 * Re-reads what changes only when something is plugged in or a policy is
 * set. These cost about as much as the battery itself, so they are kept off
 * the sampling cycle.
 */
function refreshSlowAttributes(nowUs) {
    slowRefreshedUs = nowUs;
    const sources = [];
    for (const name of sourceNames) {
        const values = optionalAttribute(`${SUPPLY_ROOT}/${name}/uevent`);
        if (values !== null)
            sources.push(parseUevent(values));
    }
    slow = {
        sources,
        chargeTypes: optionalAttribute(`${batteryDirectory}/charge_types`),
        chargeLimit: optionalAttribute(
            `${batteryDirectory}/charge_control_end_threshold`),
    };
}

/**
 * One attribute that many machines do not have, and that some expose without
 * being able to answer for it: a charge threshold reads as an I/O error while
 * the firmware is in a policy that has none.
 */
function optionalAttribute(path) {
    try {
        return readBoundedFile(path);
    } catch (_error) {
        return null;
    }
}

/**
 * Writes one line, but only when the snapshot changed or the runtime's view
 * of it is about to age. An unchanged repeat is a raw no-op in the core: it
 * costs one string comparison, performs no UI write, and keeps both the
 * stream's liveness deadline and the plugin's freshness current.
 */
function emit(raw, nowUs) {
    if (raw === lastRaw && nowUs - lastEmitUs < FRESHNESS_INTERVAL_MS * 1_000)
        return;
    try {
        output.write_all(encoder.encode(`${raw}\n`), null);
    } catch (error) {
        printerr(`[battery-power] Writing a snapshot failed: ${error.message}`);
        mainLoop.quit();
        return;
    }
    lastRaw = raw;
    lastEmitUs = nowUs;
}

/** Drops a battery that stopped answering, and looks again later. */
function forgetBattery(nowUs) {
    closeSupplies();
    nextResolveUs = nowUs + RESOLVE_RETRY_MS * 1_000;
    display.reset();
    lastFlowKey = null;
    failures = 0;
}

/** Picks the system battery and the mains supply out of the power class. */
function resolveSupplies(nowUs) {
    nextResolveUs = nowUs + RESOLVE_RETRY_MS * 1_000;
    closeSupplies();
    for (const name of listSupplies()) {
        const path = `${SUPPLY_ROOT}/${name}/uevent`;
        let values;
        try {
            values = parseUevent(readBoundedFile(path));
        } catch (_error) {
            // A supply that cannot be read is not a supply this plugin uses.
            continue;
        }
        const type = values.get('POWER_SUPPLY_TYPE');
        // Peripheral batteries report Device scope: a mouse is not the laptop.
        const system = (values.get('POWER_SUPPLY_SCOPE') ?? 'System') !== 'Device';
        const wanted = config.battery === 'auto' || config.battery === name;
        if (battery === null && type === 'Battery' && system && wanted) {
            battery = new StableReader(path);
            batteryDirectory = `${SUPPLY_ROOT}/${name}`;
        } else if (mains === null && type === 'Mains') {
            mains = new StableReader(path);
        } else if (type === 'USB' && system && sourceNames.length < MAX_SOURCES) {
            sourceNames.push(name);
        }
    }
}

function closeSupplies() {
    battery?.close();
    battery = null;
    batteryDirectory = null;
    mains?.close();
    mains = null;
    sourceNames = [];
    slow = {sources: [], chargeTypes: null, chargeLimit: null};
}

function listSupplies() {
    const names = [];
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(SUPPLY_ROOT).enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NONE,
            null);
        for (let count = 0; count < MAX_SUPPLIES; count++) {
            const info = enumerator.next_file(null);
            if (info === null)
                break;
            if (SUPPLY_NAME_PATTERN.test(info.get_name()))
                names.push(info.get_name());
        }
    } catch (error) {
        printerr(`[battery-power] Listing ${SUPPLY_ROOT} failed: ${error.message}`);
    } finally {
        try {
            enumerator?.close(null);
        } catch (_error) {
            // The next resolution opens its own enumerator.
        }
    }
    return names.sort();
}

function loadConfig() {
    const defaults = {
        intervalMs: 2_000,
        battery: 'auto',
        smoothing: DEFAULT_SMOOTHING,
        hysteresisWatts: DEFAULT_HYSTERESIS_W,
    };
    let value = {};
    try {
        value = JSON.parse(readBoundedFile('config.json'));
    } catch (error) {
        const missing = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
            error.matches?.(GLib.FileError, GLib.FileError.NOENT);
        if (!missing)
            printerr(`[battery-power] Ignoring invalid config.json: ${error.message}`);
    }
    const unknown = Object.keys(value).find(key => !Object.hasOwn(defaults, key));
    if (unknown !== undefined)
        throw new Error(`Unknown config field: ${unknown}`);
    const result = {...defaults, ...value};
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

function readBoundedFile(path) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        return readBoundedStream(stream, path);
    } finally {
        stream.close(null);
    }
}

function readBoundedStream(stream, path) {
    const chunks = [];
    let length = 0;
    while (length < MAX_UEVENT_BYTES) {
        const block = stream.read_bytes(
            Math.min(READ_BLOCK_BYTES, MAX_UEVENT_BYTES - length),
            null);
        const chunk = new Uint8Array(block.get_data());
        if (chunk.length === 0)
            break;
        chunks.push(chunk);
        length += chunk.length;
    }
    if (length >= MAX_UEVENT_BYTES && stream.read_bytes(1, null).get_size() !== 0)
        throw new Error(`${path} exceeds ${MAX_UEVENT_BYTES} bytes`);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
