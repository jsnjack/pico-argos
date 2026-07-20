// SPDX-License-Identifier: GPL-3.0-or-later

/** Parses the aggregate Linux CPU counters from /proc/stat. */
export function parseCpuStat(text) {
    const line = text.split('\n').find(value => value.startsWith('cpu '));
    if (line === undefined)
        throw new Error('/proc/stat has no aggregate CPU line');
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 8 || fields.some(value => !Number.isFinite(value) || value < 0))
        throw new Error('/proc/stat aggregate CPU line is malformed');
    const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
    const idleAll = idle + iowait;
    const nonIdle = user + nice + system + irq + softirq + steal;
    return {idle: idleAll, total: idleAll + nonIdle};
}

/** Computes aggregate CPU utilization or null across a reset/invalid delta. */
export function cpuUsage(previous, current) {
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    if (!(total > 0) || idle < 0 || idle > total)
        return null;
    return clamp(100 * (total - idle) / total, 0, 100);
}

/** Computes used memory percentage from required MemTotal/MemAvailable fields. */
export function parseMemoryUsage(text) {
    const fields = new Map();
    for (const line of text.split('\n')) {
        const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/.exec(line);
        if (match !== null)
            fields.set(match[1], Number(match[2]));
    }
    const total = fields.get('MemTotal');
    const available = fields.get('MemAvailable');
    if (!(total > 0) || available === undefined || available < 0 || available > total)
        throw new Error('/proc/meminfo lacks valid MemTotal and MemAvailable values');
    return clamp(100 * (total - available) / total, 0, 100);
}

/** Parses field 10 (milliseconds doing I/O) from /sys/block/<device>/stat. */
export function parseDiskIoMs(text) {
    const fields = text.trim().split(/\s+/).map(Number);
    if (fields.length < 10 || !Number.isFinite(fields[9]) || fields[9] < 0)
        throw new Error('Block-device stat is malformed');
    return fields[9];
}

/** Computes the bounded direct-device activity estimate. */
export function diskUsage(previousIoMs, currentIoMs, elapsedMs) {
    const delta = currentIoMs - previousIoMs;
    if (delta < 0 || !(elapsedMs > 0))
        return null;
    return clamp(100 * delta / elapsedMs, 0, 100);
}

/** Parses receive/transmit counters for one exact /proc/net/dev interface. */
export function parseNetworkCounters(text, interfaceName) {
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0 || line.slice(0, colon).trim() !== interfaceName)
            continue;
        const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (fields.length < 16 || fields.some(value => !Number.isFinite(value) || value < 0))
            throw new Error(`/proc/net/dev entry for ${interfaceName} is malformed`);
        return {receiveBytes: fields[0], transmitBytes: fields[8]};
    }
    throw new Error(`/proc/net/dev has no interface ${interfaceName}`);
}

/** Computes byte rates using actual monotonic elapsed time. */
export function networkRates(previous, current, elapsedMs, fastIntervalMs) {
    const receive = current.receiveBytes - previous.receiveBytes;
    const transmit = current.transmitBytes - previous.transmitBytes;
    if (receive < 0 || transmit < 0 ||
        elapsedMs < 0.5 * fastIntervalMs || elapsedMs > 4 * fastIntervalMs)
        return null;
    const seconds = elapsedMs / 1_000;
    return {receive: receive / seconds, transmit: transmit / seconds};
}

/** Formats one constant-width combined system label. */
export function formatSystemLabel({cpu, memory, disk, receive, transmit}) {
    return `cpu ${formatPercent(cpu)}% mem ${formatPercent(memory)}% ` +
        `io ${formatPercent(disk)}% rx ${formatRate(receive)} tx ${formatRate(transmit)}`;
}

/** Creates the public protocol snapshot for the combined indicator. */
export function systemSnapshot(metrics) {
    const text = formatSystemLabel(metrics);
    return {
        version: 1,
        type: 'snapshot',
        panel: {
            visible: true,
            text,
            appearance: 'monospace',
            accessibleName: `System utilization: ${text}`,
            severity: 'normal',
        },
        menu: [
            {id: 'cpu', kind: 'label', text: `CPU utilization ${formatDetail(metrics.cpu)}`},
            {id: 'memory', kind: 'label', text: `Memory utilization ${formatDetail(metrics.memory)}`},
            {id: 'disk', kind: 'label', text: `Disk activity ${formatDetail(metrics.disk)}`},
            {id: 'network', kind: 'label', text: `Network rx ${formatRate(metrics.receive).trim()} tx ${formatRate(metrics.transmit).trim()}`},
        ],
    };
}

function formatPercent(value) {
    return value === null || !Number.isFinite(value)
        ? ' --'
        : String(Math.round(clamp(value, 0, 100))).padStart(3);
}

function formatRate(value) {
    if (value === null || !Number.isFinite(value) || value < 0)
        return '     --';
    const units = ['B', 'K', 'M', 'G'];
    let scaled = value;
    let unit = 0;
    while (scaled >= 1_000 && unit < units.length - 1) {
        scaled /= 1_000;
        unit++;
    }
    if (unit === units.length - 1)
        scaled = Math.min(scaled, 999.9);
    let number;
    if (scaled < 10 && unit > 0)
        number = scaled.toFixed(2);
    else if (scaled < 1_000 && unit > 0)
        number = scaled.toFixed(1);
    else
        number = String(Math.round(scaled));
    return `${number}${units[unit]}`.padStart(7);
}

function formatDetail(value) {
    return value === null || !Number.isFinite(value) ? 'unavailable' : `${Math.round(value)}%`;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
