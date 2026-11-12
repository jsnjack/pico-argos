// SPDX-License-Identifier: GPL-3.0-or-later

import {
    cpuUsage,
    diskUsage,
    formatSystemLabel,
    networkRates,
    parseCpuStat,
    parseDiskIoMs,
    parseGpuUsage,
    parseMemoryUsage,
    parseNetworkCounters,
    SeverityHold,
    systemSnapshot,
} from './metrics.js';

function near(actual, expected, message) {
    if (Math.abs(actual - expected) > 0.001)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const previousCpu = parseCpuStat('cpu  100 10 40 800 20 5 5 0 0 0\ncpu0 0');
const currentCpu = parseCpuStat('cpu  130 10 50 850 20 5 5 0 0 0\n');
near(cpuUsage(previousCpu, currentCpu), 44.444444, 'CPU utilization');
if (cpuUsage(currentCpu, previousCpu) !== null)
    throw new Error('CPU counter reset was not rejected');
near(parseGpuUsage('42\n'), 42, 'GPU utilization');
for (const invalid of ['-1', '101', 'busy']) {
    try {
        parseGpuUsage(invalid);
        throw new Error(`Invalid GPU utilization was accepted: ${invalid}`);
    } catch (error) {
        if (error.message.startsWith('Invalid GPU'))
            throw error;
    }
}
near(parseMemoryUsage('MemTotal:       1000 kB\nMemAvailable:    400 kB\n'), 60, 'memory');
if (parseDiskIoMs('1 2 3 4 5 6 7 8 9 250 11') !== 250)
    throw new Error('Disk I/O field was parsed incorrectly');
near(diskUsage(100, 225, 500), 25, 'disk activity');

const networkText = 'Inter-| Receive | Transmit\n  eth0: 1000 1 2 3 4 5 6 7 2000 9 10 11 12 13 14 15\n';
const previousNetwork = parseNetworkCounters(networkText, 'eth0');
const currentNetwork = {receiveBytes: 2_000, transmitBytes: 4_000};
const rates = networkRates(previousNetwork, currentNetwork, 250, 250);
near(rates.receive, 4_000, 'receive rate');
near(rates.transmit, 8_000, 'transmit rate');
if (networkRates(currentNetwork, previousNetwork, 250, 250) !== null ||
    networkRates(previousNetwork, currentNetwork, 2_000, 250) !== null)
    throw new Error('Network reset/discontinuity was not rejected');

const metrics = {
    cpu: 12,
    gpu: 34,
    memory: 47,
    disk: 0,
    receive: 123_400,
    transmit: 2_100_000,
};
const label = formatSystemLabel(metrics);
if (label !== 'cpu  12% gpu  34% mem  47% io   0% ⏷ 123.40 KBs ⏶   2.10 MBs')
    throw new Error(`Unexpected fixed-width label: ${JSON.stringify(label)}`);
for (const values of [
    metrics,
    {cpu: 100, gpu: null, memory: null, disk: 99.5, receive: 0, transmit: 999_900_000_000},
    {cpu: 0, gpu: 0, memory: 0, disk: 0, receive: 9_999, transmit: 99_999},
]) {
    const formatted = formatSystemLabel(values);
    if ([...formatted].length !== 60)
        throw new Error(`System label width changed: ${formatted.length} ${JSON.stringify(formatted)}`);
}
const panelText = value => value.panel.segments.map(segment => segment.text).join('');
const snapshot = systemSnapshot(metrics);
if (panelText(snapshot) !== label || snapshot.menu.length !== 6)
    throw new Error('System protocol snapshot is not fixed-width and complete');
const selected = systemSnapshot(metrics, ['cpu', 'network']);
if (panelText(selected) !== 'cpu  12% ⏷ 123.40 KBs ⏶   2.10 MBs' ||
    JSON.stringify(selected.menu.map(item => item.id)) !==
        '["cpu","network-receive","network-transmit"]')
    throw new Error('System field selection changed ordering or retained omitted metrics');
if (!formatSystemLabel({...metrics, receive: 1_500_000_000}).includes('  1.50 GBs'))
    throw new Error('System network formatter omitted the bounded SI gigabyte unit');
const compact = systemSnapshot(metrics, undefined, {
    presentation: 'compact',
    thresholds: {memory: {warning: 40, critical: 90}},
    gpuDevice: 'card1',
    diskDevice: 'nvme0n1',
    networkInterface: 'wlp1s0',
});
const compactText = panelText(compact);
if (compactText !==
        'CPU  12%  GPU  34%  MEM  47%  IO   0%  ↓123.4K  ↑  2.1M' ||
    [...compactText].length !== 55 ||
    JSON.stringify(compact.panel.segments) !== JSON.stringify([
        {text: 'CPU  12%', severity: 'normal'},
        {text: '  GPU  34%', severity: 'normal'},
        {text: '  MEM  47%', severity: 'warning'},
        {text: '  IO   0%', severity: 'normal'},
        {text: '  ↓123.4K  ↑  2.1M', severity: 'normal'},
    ]) ||
    compact.panel.severity !== undefined ||
    compact.menu.find(item => item.id === 'source-0')?.text !==
        'GPU device: card1' ||
    compact.menu.find(item => item.id === 'source-1')?.text !==
        'Block device: nvme0n1' ||
    compact.menu.find(item => item.id === 'source-2')?.text !==
        'Network interface: wlp1s0') {
    throw new Error(`Compact system presentation is invalid: ${JSON.stringify(compact)}`);
}
const critical = systemSnapshot(metrics, undefined, {
    thresholds: {cpu: {warning: 5, critical: 10}, gpu: {warning: 30}},
});
if (JSON.stringify(critical.panel.segments.map(segment => segment.severity)) !==
        '["critical","warning","normal","normal","normal"]')
    throw new Error('System thresholds did not color only the metrics over them');

function heldSeverities(samples) {
    const limits = {warning: 80, critical: 90};
    const hold = new SeverityHold({cpu: limits, gpu: limits, memory: limits}, 3_000);
    return samples.map(([nowMs, values]) => {
        const severities = hold.update(
            {cpu: null, gpu: null, memory: null, ...values}, ['cpu', 'gpu', 'memory'], nowMs);
        // Each sample changes one field; the others stay normal.
        const field = Object.keys(values)[0];
        if (Object.entries(severities).some(([other, severity]) =>
            other !== field && severity !== 'normal'))
            throw new Error(`A ${field} sample changed another field's severity`);
        return severities[field];
    });
}

function expectSeverities(samples, expected, message) {
    const actual = heldSeverities(samples);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${expected.join(',')}, got ${actual.join(',')}`);
}

expectSeverities(
    [[0, {cpu: 10}], [1_000, {cpu: 95}], [2_000, {cpu: 95}], [3_000, {cpu: 10}],
        [4_000, {cpu: 10}]],
    ['normal', 'normal', 'normal', 'normal', 'normal'],
    'A CPU spike shorter than the hold changed severity');
expectSeverities(
    [[0, {cpu: 10}], [1_000, {cpu: 95}], [2_000, {cpu: 95}], [3_000, {cpu: 95}],
        [4_000, {cpu: 10}], [5_000, {cpu: 10}], [6_000, {cpu: 10}]],
    ['normal', 'normal', 'normal', 'critical', 'critical', 'critical', 'normal'],
    'Sustained CPU load did not turn critical and clear after the hold');
expectSeverities(
    [[0, {cpu: 10}], [1_004, {cpu: 95}], [2_001, {cpu: 95}], [3_002, {cpu: 95}]],
    ['normal', 'normal', 'normal', 'critical'],
    'Late timer callbacks delayed the hold by one sample');
expectSeverities(
    [[0, {cpu: 10}], [100, {cpu: 95}], [2_900, {cpu: 95}], [3_000, {cpu: 95}]],
    ['normal', 'normal', 'normal', 'critical'],
    'The timer slack ended a hold one 100-ms sample early');
expectSeverities(
    [[0, {gpu: 10}], [1_000, {gpu: 85}], [2_000, {gpu: 95}], [3_000, {gpu: 85}],
        [4_000, {gpu: 95}]],
    ['normal', 'normal', 'normal', 'warning', 'warning'],
    'GPU load alternating between thresholds did not settle on warning');
expectSeverities(
    [[0, {memory: 95}], [1_000, {memory: 85}], [2_000, {memory: 50}]],
    ['critical', 'warning', 'normal'],
    'Memory severity did not follow the current sample');
print('ok - system monitor parses counters and formats both fixed-width presentations');
