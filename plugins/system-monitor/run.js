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
    parseGpuUsage,
    parseMemoryUsage,
    parseNetworkCounters,
    SeverityHold,
    systemSnapshot,
} from './metrics.js';
import {readSystemMonitorSettings} from './settings.js';
import {SystemTimingTrace} from './timing-trace.js';

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

const config = readSystemMonitorSettings(
    message => printerr(`[system-monitor] ${message}`));
const timingTrace = config.diagnosticTracePath === null
    ? null
    : new SystemTimingTrace(config.diagnosticTracePath);
const selectedFields = new Set(config.fields);
const readers = {
    cpu: new StableReader('/proc/stat'),
    gpu: null,
    memory: new StableReader('/proc/meminfo'),
    network: new StableReader('/proc/net/dev'),
    disk: null,
};
let gpuDevice = selectedFields.has('gpu')
    ? resolveGpuDevice(config.gpuDevice)
    : null;
if (selectedFields.has('gpu') && gpuDevice !== null)
    readers.gpu = new StableReader(`/sys/class/drm/${gpuDevice}/device/gpu_busy_percent`);
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
    gpu: safely(() => selectedFields.has('gpu') && readers.gpu !== null
        ? parseGpuUsage(readers.gpu.read(startupBudget))
        : null),
    memory: safely(() => selectedFields.has('memory')
        ? parseMemoryUsage(readers.memory.read(startupBudget))
        : null),
    disk: null,
    receive: 0,
    transmit: 0,
};
let nextFastUs = selectedFields.has('cpu') || selectedFields.has('gpu') ||
    selectedFields.has('network')
    ? startedUs + config.fastIntervalMs * 1_000
    : Number.POSITIVE_INFINITY;
let nextDiskUs = selectedFields.has('disk')
    ? startedUs + config.diskIntervalMs * 1_000
    : Number.POSITIVE_INFINITY;
let nextMemoryUs = selectedFields.has('memory')
    ? startedUs + config.memoryIntervalMs * 1_000
    : Number.POSITIVE_INFINITY;
const severityHold = new SeverityHold(config.thresholds);
let severity = 'normal';
let lastEmissionUs = startedUs;
let lastSnapshot = null;
let outputSequence = 0;

monitorResolutionChanges();
const mainLoop = new GLib.MainLoop(null, false);
if (timingTrace !== null) {
    for (const signal of [2, 15]) {
        GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal, () => {
            try {
                timingTrace.export();
            } catch (error) {
                printerr(`[system-monitor] Timing trace export failed: ${error.message}`);
            }
            mainLoop.quit();
            return GLib.SOURCE_REMOVE;
        });
    }
}
schedule();
mainLoop.run();

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
    let fastDeadlineUs = 0;
    if (nowUs >= nextFastUs) {
        fastDeadlineUs = nextFastUs;
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

    if (sampled)
        severity = severityHold.update(metrics, config.fields, nowUs / 1_000);

    const sampleEndUs = GLib.get_monotonic_time();
    let formatBeginUs = 0;
    let formatEndUs = 0;
    let writeBeginUs = 0;
    let writeEndUs = 0;
    let snapshotSequence = 0;

    if (sampled && nowUs - lastEmissionUs >= 1_000_000 / MAX_EMITS_PER_SECOND) {
        formatBeginUs = GLib.get_monotonic_time();
        const snapshot = JSON.stringify(systemSnapshot(metrics, config.fields, {
            presentation: config.presentation,
            severity,
            gpuDevice,
            diskDevice,
            networkInterface,
        }));
        formatEndUs = GLib.get_monotonic_time();
        if (snapshot !== lastSnapshot) {
            writeBeginUs = GLib.get_monotonic_time();
            snapshotSequence = writeLine(snapshot);
            writeEndUs = GLib.get_monotonic_time();
            lastSnapshot = snapshot;
            lastEmissionUs = nowUs;
        }
    }
    if (fastDeadlineUs !== 0) {
        timingTrace?.record([
            fastDeadlineUs,
            nowUs,
            sampleEndUs,
            formatBeginUs,
            formatEndUs,
            writeBeginUs,
            writeEndUs,
            snapshotSequence,
        ]);
    }
    if (snapshotSequence === 0 && nowUs - lastEmissionUs >= HEARTBEAT_INTERVAL_US) {
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

    const currentGpu = safely(() => selectedFields.has('gpu') && readers.gpu !== null
        ? parseGpuUsage(readers.gpu.read(budget))
        : null);
    if (currentGpu !== null)
        metrics.gpu = currentGpu;

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
    if (selectedFields.has('gpu') && config.gpuDevice === 'auto') {
        try {
            const monitor = Gio.File.new_for_path('/sys/class/drm').monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null);
            monitors.push(monitor);
            monitor.connect('changed', () => {
                const resolved = resolveGpuDevice('auto');
                if (resolved === gpuDevice)
                    return;
                readers.gpu?.close();
                gpuDevice = resolved;
                readers.gpu = resolved === null
                    ? null
                    : new StableReader(
                        `/sys/class/drm/${resolved}/device/gpu_busy_percent`);
                metrics.gpu = null;
            });
        } catch (_error) {
            // The startup DRM selection remains stable until process restart.
        }
    }
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

function resolveNetworkInterface(configured) {
    if (configured !== 'auto')
        return configured;
    return resolveNetworkManagerInterface() ?? resolveRouteInterface();
}

function resolveGpuDevice(configured) {
    if (configured !== 'auto')
        return configured;
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path('/sys/class/drm').enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NONE,
            null);
        const candidates = [];
        for (let count = 0; count < 64; count++) {
            const info = enumerator.next_file(null);
            if (info === null)
                break;
            const name = info.get_name();
            if (/^card[0-9]{1,3}$/.test(name))
                candidates.push(name);
        }
        candidates.sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)));
        let fallback = null;
        for (const name of candidates.slice(0, 16)) {
            const busyPath = `/sys/class/drm/${name}/device/gpu_busy_percent`;
            try {
                parseGpuUsage(readBoundedFile(busyPath));
                fallback ??= name;
                if (readBoundedFile(`/sys/class/drm/${name}/device/boot_vga`).trim() === '1')
                    return name;
            } catch (_error) {
                // Unsupported DRM cards are skipped without a vendor process.
            }
        }
        return fallback;
    } catch (_error) {
        return null;
    } finally {
        try {
            enumerator?.close(null);
        } catch (_error) {
            // Process teardown also releases the startup-only enumerator.
        }
    }
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
    outputSequence++;
    return outputSequence;
}
