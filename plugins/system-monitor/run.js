#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import {
    cpuUsage,
    diskUsage,
    networkRates,
    parseCpuStat,
    parseDiskIoMs,
    parseMemoryUsage,
    parseNetworkCounters,
    systemSnapshot,
} from './metrics.js';

const MAX_FILE_BYTES = 64 * 1_024;
const MAX_EMITS_PER_SECOND = 5;
const HEARTBEAT_INTERVAL_US = 2_000_000;
const output = GioUnix.OutputStream.new(1, false);
const encoder = new TextEncoder();
const monitors = [];

class StableReader {
    constructor(path) {
        this.path = path;
        this._stream = null;
    }

    read(budget) {
        try {
            this._stream ??= Gio.File.new_for_path(this.path).read(null);
            this._stream.seek(0, GLib.SeekType.SET, null);
            return readBoundedStream(this._stream, budget, `Sampling ${this.path}`);
        } catch (error) {
            this.close();
            throw error;
        }
    }

    close() {
        try {
            this._stream?.close(null);
        } catch (_error) {
            // Reopening on the next sample is the recovery path.
        }
        this._stream = null;
    }
}

class SampleBudget {
    constructor() {
        this.remaining = MAX_FILE_BYTES;
    }

    consume(bytes) {
        if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.remaining)
            throw new Error('Sampling cycle exceeds 64 KiB');
        this.remaining -= bytes;
    }
}

const config = loadConfig();
const selectedFields = new Set(config.fields);
const readers = {
    cpu: new StableReader('/proc/stat'),
    memory: new StableReader('/proc/meminfo'),
    network: new StableReader('/proc/net/dev'),
    disk: null,
};
let networkInterface = selectedFields.has('network')
    ? resolveNetworkInterface(config.networkInterface)
    : null;
let diskDevice = selectedFields.has('disk')
    ? resolveDiskDevice(config.diskDevice)
    : null;
if (selectedFields.has('disk') && diskDevice !== null)
    readers.disk = new StableReader(`/sys/block/${diskDevice}/stat`);

const startedUs = GLib.get_monotonic_time();
const startupBudget = new SampleBudget();
let cpuBaseline = safely(() => selectedFields.has('cpu')
    ? parseCpuStat(readers.cpu.read(startupBudget))
    : null);
let networkBaseline = safely(() => !selectedFields.has('network') ||
    networkInterface === null
    ? null
    : parseNetworkCounters(readers.network.read(startupBudget), networkInterface));
let networkBaselineUs = startedUs;
let diskBaseline = safely(() => !selectedFields.has('disk') || readers.disk === null
    ? null
    : parseDiskIoMs(readers.disk.read(startupBudget)));
let diskBaselineUs = startedUs;
const metrics = {
    cpu: null,
    memory: safely(() => selectedFields.has('memory')
        ? parseMemoryUsage(readers.memory.read(startupBudget))
        : null),
    disk: null,
    receive: 0,
    transmit: 0,
};
let nextFastUs = selectedFields.has('cpu') || selectedFields.has('network')
    ? startedUs + config.fastIntervalMs * 1_000
    : Number.POSITIVE_INFINITY;
let nextDiskUs = selectedFields.has('disk')
    ? startedUs + config.diskIntervalMs * 1_000
    : Number.POSITIVE_INFINITY;
let nextMemoryUs = selectedFields.has('memory')
    ? startedUs + config.memoryIntervalMs * 1_000
    : Number.POSITIVE_INFINITY;
let lastEmissionUs = startedUs;
let lastSnapshot = null;

monitorResolutionChanges();
schedule();
new GLib.MainLoop(null, false).run();

function schedule() {
    const nowUs = GLib.get_monotonic_time();
    const heartbeatUs = lastEmissionUs + HEARTBEAT_INTERVAL_US;
    const deadlineUs = Math.min(nextFastUs, nextDiskUs, nextMemoryUs, heartbeatUs);
    const delayMs = Math.max(1, Math.ceil((deadlineUs - nowUs) / 1_000));
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        sample();
        schedule();
        return GLib.SOURCE_REMOVE;
    });
}

function sample() {
    const nowUs = GLib.get_monotonic_time();
    const budget = new SampleBudget();
    let sampled = false;
    if (nowUs >= nextFastUs) {
        sampleFast(nowUs, budget);
        nextFastUs = advanceDeadline(nextFastUs, config.fastIntervalMs, nowUs);
        sampled = true;
    }
    if (nowUs >= nextDiskUs) {
        sampleDisk(nowUs, budget);
        nextDiskUs = advanceDeadline(nextDiskUs, config.diskIntervalMs, nowUs);
        sampled = true;
    }
    if (nowUs >= nextMemoryUs) {
        const memory = safely(() => parseMemoryUsage(readers.memory.read(budget)));
        if (memory !== null)
            metrics.memory = memory;
        nextMemoryUs = advanceDeadline(nextMemoryUs, config.memoryIntervalMs, nowUs);
        sampled = true;
    }

    if (sampled && nowUs - lastEmissionUs >= 1_000_000 / MAX_EMITS_PER_SECOND) {
        const snapshot = JSON.stringify(systemSnapshot(metrics, config.fields));
        if (snapshot !== lastSnapshot) {
            writeLine(snapshot);
            lastSnapshot = snapshot;
            lastEmissionUs = nowUs;
            return;
        }
    }
    if (nowUs - lastEmissionUs >= HEARTBEAT_INTERVAL_US) {
        writeLine('{"version":1,"type":"heartbeat"}');
        lastEmissionUs = nowUs;
    }
}

function sampleFast(nowUs, budget) {
    const currentCpu = safely(() => selectedFields.has('cpu')
        ? parseCpuStat(readers.cpu.read(budget))
        : null);
    if (cpuBaseline !== null && currentCpu !== null) {
        const usage = cpuUsage(cpuBaseline, currentCpu);
        if (usage !== null)
            metrics.cpu = usage;
    }
    if (currentCpu !== null) {
        cpuBaseline = currentCpu;
    }

    const currentNetwork = safely(() => !selectedFields.has('network') ||
        networkInterface === null
        ? null
        : parseNetworkCounters(readers.network.read(budget), networkInterface));
    if (networkBaseline !== null && currentNetwork !== null) {
        const rates = networkRates(
            networkBaseline,
            currentNetwork,
            (nowUs - networkBaselineUs) / 1_000,
            config.fastIntervalMs);
        if (rates === null) {
            metrics.receive = 0;
            metrics.transmit = 0;
        } else {
            metrics.receive = rates.receive;
            metrics.transmit = rates.transmit;
        }
    }
    networkBaseline = currentNetwork;
    networkBaselineUs = nowUs;
}

function sampleDisk(nowUs, budget) {
    const current = safely(() => readers.disk === null
        ? null
        : parseDiskIoMs(readers.disk.read(budget)));
    if (diskBaseline !== null && current !== null) {
        const usage = diskUsage(diskBaseline, current, (nowUs - diskBaselineUs) / 1_000);
        if (usage !== null)
            metrics.disk = usage;
    }
    diskBaseline = current;
    diskBaselineUs = nowUs;
}

function monitorResolutionChanges() {
    if (selectedFields.has('network') && config.networkInterface === 'auto') {
        try {
            Gio.DBus.system.signal_subscribe(
                'org.freedesktop.NetworkManager',
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                '/org/freedesktop/NetworkManager',
                null,
                Gio.DBusSignalFlags.NONE,
                () => {
                    const resolved = resolveNetworkInterface('auto');
                    if (resolved !== networkInterface) {
                        networkInterface = resolved;
                        networkBaseline = null;
                        metrics.receive = 0;
                        metrics.transmit = 0;
                    }
                });
        } catch (_error) {
            // The cached route fallback remains valid until process restart.
        }
    }
    if (selectedFields.has('disk') && config.diskDevice === 'auto') {
        try {
            const monitor = Gio.File.new_for_path('/proc/self/mountinfo').monitor_file(
                Gio.FileMonitorFlags.NONE,
                null);
            monitors.push(monitor);
            monitor.connect('changed', () => {
                const resolved = resolveDiskDevice('auto');
                if (resolved === diskDevice)
                    return;
                readers.disk?.close();
                diskDevice = resolved;
                readers.disk = resolved === null
                    ? null
                    : new StableReader(`/sys/block/${resolved}/stat`);
                diskBaseline = null;
                metrics.disk = null;
            });
        } catch (_error) {
            // The cached root device remains valid until process restart.
        }
    }
}

function loadConfig() {
    const defaults = {
        fastIntervalMs: 250,
        diskIntervalMs: 500,
        memoryIntervalMs: 1_000,
        fields: ['cpu', 'memory', 'disk', 'network'],
        diskDevice: 'auto',
        networkInterface: 'auto',
    };
    let value = {};
    try {
        value = JSON.parse(readBoundedFile('config.json'));
    } catch (error) {
        const missing = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
            error.matches?.(GLib.FileError, GLib.FileError.NOENT);
        if (!missing)
            printerr(`[system-monitor] Ignoring invalid config.json: ${error.message}`);
    }
    const allowed = new Set([
        'fastIntervalMs',
        'diskIntervalMs',
        'memoryIntervalMs',
        'fields',
        'diskDevice',
        'networkInterface',
    ]);
    const unknown = Object.keys(value).find(key => !allowed.has(key));
    if (unknown !== undefined)
        throw new Error(`Unknown config field: ${unknown}`);
    const result = {...defaults, ...value};
    requireRange(result.fastIntervalMs, 100, 2_000, 'fastIntervalMs');
    requireRange(result.diskIntervalMs, 100, 10_000, 'diskIntervalMs');
    requireRange(result.memoryIntervalMs, 100, 10_000, 'memoryIntervalMs');
    if (!Array.isArray(result.fields) || result.fields.length === 0 ||
        result.fields.length > 4 || new Set(result.fields).size !== result.fields.length ||
        result.fields.some(field => !['cpu', 'memory', 'disk', 'network'].includes(field))) {
        throw new Error('fields must contain unique CPU, memory, disk, or network names');
    }
    for (const field of ['diskDevice', 'networkInterface']) {
        if (typeof result[field] !== 'string' || !/^(auto|[A-Za-z0-9_.:-]+)$/.test(result[field]))
            throw new Error(`Invalid ${field}`);
    }
    return result;
}

function resolveNetworkInterface(configured) {
    if (configured !== 'auto')
        return configured;
    return resolveNetworkManagerInterface() ?? resolveRouteInterface();
}

function resolveNetworkManagerInterface() {
    try {
        const primary = dbusProperty(
            '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager',
            'PrimaryConnection').deepUnpack();
        if (primary === '/')
            return null;
        const devices = dbusProperty(
            primary,
            'org.freedesktop.NetworkManager.Connection.Active',
            'Devices').deepUnpack();
        if (devices.length === 0)
            return null;
        return dbusProperty(
            devices[0],
            'org.freedesktop.NetworkManager.Device',
            'Interface').deepUnpack();
    } catch (_error) {
        return null;
    }
}

function dbusProperty(path, interfaceName, property) {
    const result = Gio.DBus.system.call_sync(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.DBus.Properties',
        'Get',
        new GLib.Variant('(ss)', [interfaceName, property]),
        new GLib.VariantType('(v)'),
        Gio.DBusCallFlags.NONE,
        1_000,
        null);
    return result.get_child_value(0).get_variant();
}

function resolveRouteInterface() {
    try {
        for (const line of readBoundedFile('/proc/net/route').split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields.length >= 4 && fields[1] === '00000000' &&
                (Number.parseInt(fields[3], 16) & 0x1) !== 0)
                return fields[0];
        }
    } catch (_error) {
        // An unavailable route produces stable zero network rates.
    }
    return null;
}

function resolveDiskDevice(configured) {
    if (configured !== 'auto')
        return configured;
    try {
        const root = readBoundedFile('/proc/self/mountinfo').split('\n').find(line => {
            const fields = line.split(' ');
            return fields[4] === '/';
        });
        if (root === undefined)
            return null;
        const majorMinor = root.split(' ')[2];
        const target = GLib.file_read_link(`/sys/dev/block/${majorMinor}`);
        const parts = target.split('/');
        const blockIndex = parts.lastIndexOf('block');
        return blockIndex >= 0 ? parts[blockIndex + 1] ?? null : null;
    } catch (_error) {
        return null;
    }
}

function advanceDeadline(deadlineUs, intervalMs, nowUs) {
    const intervalUs = intervalMs * 1_000;
    return deadlineUs + (Math.floor((nowUs - deadlineUs) / intervalUs) + 1) * intervalUs;
}

function safely(callback) {
    try {
        return callback();
    } catch (_error) {
        return null;
    }
}

function requireRange(value, minimum, maximum, name) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
        throw new Error(`${name} must be from ${minimum} through ${maximum}`);
}

function readBoundedFile(path) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        return readBoundedStream(stream, new SampleBudget(), path);
    } finally {
        stream.close(null);
    }
}

function readBoundedStream(stream, budget, context) {
    if (budget.remaining === 0)
        throw new Error(`${context} exceeds the 64-KiB cycle budget`);
    const chunks = [];
    let length = 0;
    while (budget.remaining > 0) {
        const block = stream.read_bytes(Math.min(8 * 1_024, budget.remaining), null);
        const chunk = new Uint8Array(block.get_data());
        if (chunk.length === 0)
            break;
        budget.consume(chunk.length);
        length += chunk.length;
        chunks.push(chunk);
    }
    if (budget.remaining === 0 && stream.read_bytes(1, null).get_size() !== 0)
        throw new Error(`${context} exceeds the 64-KiB cycle budget`);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

function writeLine(value) {
    output.write_all(encoder.encode(`${value}\n`), null);
}
