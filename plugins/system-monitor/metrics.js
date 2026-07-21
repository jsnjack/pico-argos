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

/** Parses a Linux DRM gpu_busy_percent utilization sample. */
export function parseGpuUsage(text) {
    const value = Number(text.trim());
    if (!Number.isFinite(value) || value < 0 || value > 100)
        throw new Error('DRM GPU utilization is malformed');
    return value;
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

const ALL_FIELDS = Object.freeze(['cpu', 'gpu', 'memory', 'disk', 'network']);

/** Formats one constant-width combined system label for selected fields. */
export function formatSystemLabel(
    {cpu, gpu, memory, disk, receive, transmit}, fields = ALL_FIELDS,
    presentation = 'legacy') {
    const selected = new Set(fields);
    if (presentation === 'compact') {
        const parts = [];
        if (selected.has('cpu'))
            parts.push(`CPU ${formatPercent(cpu)}%`);
        if (selected.has('gpu'))
            parts.push(`GPU ${formatPercent(gpu)}%`);
        if (selected.has('memory'))
            parts.push(`MEM ${formatPercent(memory)}%`);
        if (selected.has('disk'))
            parts.push(`IO ${formatPercent(disk)}%`);
        if (selected.has('network')) {
            parts.push(`↓${formatCompactRate(receive)}`);
            parts.push(`↑${formatCompactRate(transmit)}`);
        }
        return parts.join('  ');
    }
    const parts = [];
    if (selected.has('cpu'))
        parts.push(`cpu ${formatPercent(cpu)}%`);
    if (selected.has('gpu'))
        parts.push(`gpu ${formatPercent(gpu)}%`);
    if (selected.has('memory'))
        parts.push(`mem ${formatPercent(memory)}%`);
    if (selected.has('disk'))
        parts.push(`io ${formatPercent(disk)}%`);
    if (selected.has('network'))
        parts.push(`⏷ ${formatRate(receive)} ⏶ ${formatRate(transmit)}`);
    return parts.join(' ');
}

/** Creates the public protocol snapshot for the combined indicator. */
export function systemSnapshot(metrics, fields = ALL_FIELDS, options = {}) {
    const selected = new Set(fields);
    const presentation = options.presentation ?? 'legacy';
    const text = formatSystemLabel(metrics, fields, presentation);
    const menu = [];
    if (selected.has('cpu'))
        menu.push(detail('cpu', 'CPU utilization', formatDetail(metrics.cpu)));
    if (selected.has('gpu'))
        menu.push(detail('gpu', 'GPU utilization', formatDetail(metrics.gpu)));
    if (selected.has('memory'))
        menu.push(detail('memory', 'Memory utilization', formatDetail(metrics.memory)));
    if (selected.has('disk'))
        menu.push(detail('disk', 'Disk activity', formatDetail(metrics.disk)));
    if (selected.has('network')) {
        menu.push(detail('network-receive', 'Network receive', formatDetailRate(metrics.receive)));
        menu.push(detail('network-transmit', 'Network transmit', formatDetailRate(metrics.transmit)));
    }
    const sources = [];
    if (selected.has('gpu') && options.gpuDevice)
        sources.push(`GPU device: ${options.gpuDevice}`);
    if (selected.has('disk') && options.diskDevice)
        sources.push(`Block device: ${options.diskDevice}`);
    if (selected.has('network') && options.networkInterface)
        sources.push(`Network interface: ${options.networkInterface}`);
    if (sources.length !== 0) {
        menu.push({id: 'sources-separator', kind: 'separator'});
        sources.forEach((source, index) => menu.push({
            id: `source-${index}`,
            kind: 'label',
            text: source,
        }));
    }
    return {
        version: 1,
        type: 'snapshot',
        panel: {
            visible: true,
            text,
            appearance: 'monospace',
            accessibleName: `System utilization: ${text}`,
            severity: metricSeverity(metrics, fields, options.thresholds ?? {}),
        },
        menu,
    };
}

function formatCompactRate(value) {
    if (value === null || !Number.isFinite(value) || value < 0)
        return '   --K';
    const unit = value >= 1_000_000_000 ? 'G' : value >= 1_000_000 ? 'M' : 'K';
    const divisor = unit === 'G' ? 1_000_000_000 : unit === 'M' ? 1_000_000 : 1_000;
    return `${Math.min(value / divisor, 999.9).toFixed(1).padStart(5)}${unit}`;
}

function formatPercent(value) {
    return value === null || !Number.isFinite(value)
        ? ' --'
        : String(Math.round(clamp(value, 0, 100))).padStart(3);
}

function formatRate(value) {
    if (value === null || !Number.isFinite(value) || value < 0)
        return '    -- KBs';
    const unit = value >= 1_000_000_000 ? 'GBs' : value >= 1_000_000 ? 'MBs' : 'KBs';
    const divisor = unit === 'GBs' ? 1_000_000_000 : unit === 'MBs' ? 1_000_000 : 1_000;
    const scaled = Math.min(value / divisor, 999.99);
    return `${scaled.toFixed(2).padStart(6)} ${unit}`;
}

function formatDetail(value) {
    return value === null || !Number.isFinite(value) ? 'unavailable' : `${Math.round(value)}%`;
}

function formatDetailRate(value) {
    return formatRate(value).trim()
        .replace('KBs', 'kB/s')
        .replace('MBs', 'MB/s')
        .replace('GBs', 'GB/s');
}

function detail(id, name, value) {
    return {
        id,
        kind: 'label',
        text: `${name.padEnd(20)}${value.padStart(12)}`,
    };
}

function metricSeverity(metrics, fields, thresholds) {
    let warning = false;
    for (const field of fields) {
        const threshold = thresholds[field];
        const value = field === 'memory' ? metrics.memory : metrics[field];
        if (threshold === undefined || !Number.isFinite(value))
            continue;
        if (threshold.critical !== undefined && value >= threshold.critical)
            return 'critical';
        if (threshold.warning !== undefined && value >= threshold.warning)
            warning = true;
    }
    return warning ? 'warning' : 'normal';
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
