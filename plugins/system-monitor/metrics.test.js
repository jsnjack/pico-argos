// SPDX-License-Identifier: GPL-3.0-or-later

import {
    cpuUsage,
    diskUsage,
    formatSystemLabel,
    networkRates,
    parseCpuStat,
    parseDiskIoMs,
    parseMemoryUsage,
    parseNetworkCounters,
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

const metrics = {cpu: 12, memory: 47, disk: 0, receive: 123_400, transmit: 2_100_000};
const label = formatSystemLabel(metrics);
if (label !== 'cpu  12% mem  47% io   0% rx  123.4K tx   2.10M')
    throw new Error(`Unexpected fixed-width label: ${JSON.stringify(label)}`);
for (const values of [
    metrics,
    {cpu: 100, memory: null, disk: 99.5, receive: 0, transmit: 999_900_000_000},
    {cpu: 0, memory: 0, disk: 0, receive: 9_999, transmit: 99_999},
]) {
    const formatted = formatSystemLabel(values);
    if (formatted.length !== 47)
        throw new Error(`System label width changed: ${formatted.length} ${JSON.stringify(formatted)}`);
}
const snapshot = systemSnapshot(metrics);
if (snapshot.panel.text.length !== 47 || snapshot.menu.length !== 4)
    throw new Error('System protocol snapshot is not fixed-width and complete');
print('ok - system monitor parses counters and formats fixed-width state');
