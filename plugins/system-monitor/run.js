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

    read() {
        try {
            this._stream ??= Gio.File.new_for_path(this.path).read(null);
            this._stream.seek(0, GLib.SeekType.SET, null);
            const block = this._stream.read_bytes(MAX_FILE_BYTES, null);
            const bytes = new Uint8Array(block.get_data());
            if (bytes.length === MAX_FILE_BYTES &&
                this._stream.read_bytes(1, null).get_size() !== 0)
                throw new Error(`${this.path} exceeds ${MAX_FILE_BYTES} bytes`);
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
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

const config = loadConfig();
const readers = {
    cpu: new StableReader('/proc/stat'),
    memory: new StableReader('/proc/meminfo'),
    network: new StableReader('/proc/net/dev'),
    disk: null,
};
let networkInterface = resolveNetworkInterface(config.networkInterface);
let diskDevice = resolveDiskDevice(config.diskDevice);
if (diskDevice !== null)
    readers.disk = new StableReader(`/sys/block/${diskDevice}/stat`);

const startedUs = GLib.get_monotonic_time();
let cpuBaseline = safely(() => parseCpuStat(readers.cpu.read()));
let networkBaseline = safely(() => networkInterface === null
    ? null
    : parseNetworkCounters(readers.network.read(), networkInterface));
let networkBaselineUs = startedUs;
let diskBaseline = safely(() => readers.disk === null
    ? null
    : parseDiskIoMs(readers.disk.read()));
let diskBaselineUs = startedUs;
const metrics = {
    cpu: null,
    memory: safely(() => parseMemoryUsage(readers.memory.read())),
    disk: null,
    receive: 0,
    transmit: 0,
};
let nextFastUs = startedUs + config.fastIntervalMs * 1_000;
let nextDiskUs = startedUs + config.diskIntervalMs * 1_000;
let nextMemoryUs = startedUs + config.memoryIntervalMs * 1_000;
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
    let sampled = false;
    if (nowUs >= nextFastUs) {
        sampleFast(nowUs);
        nextFastUs = advanceDeadline(nextFastUs, config.fastIntervalMs, nowUs);
        sampled = true;
    }
    if (nowUs >= nextDiskUs) {
        sampleDisk(nowUs);
        nextDiskUs = advanceDeadline(nextDiskUs, config.diskIntervalMs, nowUs);
        sampled = true;
    }
    if (nowUs >= nextMemoryUs) {
        const memory = safely(() => parseMemoryUsage(readers.memory.read()));
        if (memory !== null)
            metrics.memory = memory;
        nextMemoryUs = advanceDeadline(nextMemoryUs, config.memoryIntervalMs, nowUs);
        sampled = true;
    }

    if (sampled && nowUs - lastEmissionUs >= 1_000_000 / MAX_EMITS_PER_SECOND) {
        const snapshot = JSON.stringify(systemSnapshot(metrics));
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

function sampleFast(nowUs) {
    const currentCpu = safely(() => parseCpuStat(readers.cpu.read()));
    if (cpuBaseline !== null && currentCpu !== null) {
        const usage = cpuUsage(cpuBaseline, currentCpu);
        if (usage !== null)
            metrics.cpu = usage;
    }
    if (currentCpu !== null) {
        cpuBaseline = currentCpu;
    }

    const currentNetwork = safely(() => networkInterface === null
        ? null
        : parseNetworkCounters(readers.network.read(), networkInterface));
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

function sampleDisk(nowUs) {
    const current = safely(() => readers.disk === null
        ? null
        : parseDiskIoMs(readers.disk.read()));
    if (diskBaseline !== null && current !== null) {
        const usage = diskUsage(diskBaseline, current, (nowUs - diskBaselineUs) / 1_000);
        if (usage !== null)
            metrics.disk = usage;
    }
    diskBaseline = current;
    diskBaselineUs = nowUs;
}

function monitorResolutionChanges() {
    if (config.networkInterface === 'auto') {
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
    if (config.diskDevice === 'auto') {
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
        diskDevice: 'auto',
        networkInterface: 'auto',
    };
    let value = {};
    try {
        const [, bytes] = GLib.file_get_contents('config.json');
        value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        if (!error.matches?.(GLib.FileError, GLib.FileError.NOENT))
            printerr(`[system-monitor] Ignoring invalid config.json: ${error.message}`);
    }
    const result = {...defaults, ...value};
    requireRange(result.fastIntervalMs, 100, 2_000, 'fastIntervalMs');
    requireRange(result.diskIntervalMs, 100, 10_000, 'diskIntervalMs');
    requireRange(result.memoryIntervalMs, 100, 10_000, 'memoryIntervalMs');
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
        const [, bytes] = GLib.file_get_contents('/proc/net/route');
        for (const line of new TextDecoder().decode(bytes).split('\n').slice(1)) {
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
        const [, bytes] = GLib.file_get_contents('/proc/self/mountinfo');
        const root = new TextDecoder().decode(bytes).split('\n').find(line => {
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

function writeLine(value) {
    output.write_all(encoder.encode(`${value}\n`), null);
}
