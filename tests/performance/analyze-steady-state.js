#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import System from 'system';

const MAX_INPUT_BYTES = 4 * 1_024 * 1_024;
if (ARGV.length !== 3) {
    throw new Error(
        'Usage: analyze-steady-state.js SUMMARY_BEFORE SUMMARY_AFTER PROCESS_MEMORY_TSV');
}
const before = readJson(ARGV[0]);
const after = readJson(ARGV[1]);
const samples = readMemory(ARGV[2]);
if (before.available === false || after.available === false)
    throw new Error('Steady-state analysis requires live extension summaries');
if (samples.length < 30)
    throw new Error('Steady-state analysis requires at least 30 Shell RSS samples');

const beforeMutations = before.diagnostics.mutations;
const afterMutations = after.diagnostics.mutations;
const beforePlugins = before.runtime.plugins.map(plugin => plugin.id).sort();
const afterPlugins = after.runtime.plugins.map(plugin => plugin.id).sort();
const actorStable = beforeMutations['actor-creations'] ===
        afterMutations['actor-creations'] &&
    beforeMutations['actor-destructions'] === afterMutations['actor-destructions'];
const pluginSetStable = JSON.stringify(beforePlugins) === JSON.stringify(afterPlugins);
const rss = samples.map(sample => sample.rssKiB);
const monotonicallyGrowing = rss.every((value, index) =>
    index === 0 || value >= rss[index - 1]) && rss.at(-1) > rss[0];
const slopeKiBPerHour = regressionSlope(samples) * 3_600;
const quarter = Math.max(1, Math.floor(rss.length / 4));
const firstQuarterMedian = median(rss.slice(0, quarter));
const lastQuarterMedian = median(rss.slice(-quarter));
const document = {
    formatVersion: 1,
    project: 'pico-argos',
    durationSeconds: samples.at(-1).seconds - samples[0].seconds,
    sampleCount: samples.length,
    pluginSetStable,
    actorMutations: {
        stable: actorStable,
        creationsBefore: beforeMutations['actor-creations'],
        creationsAfter: afterMutations['actor-creations'],
        destructionsBefore: beforeMutations['actor-destructions'],
        destructionsAfter: afterMutations['actor-destructions'],
    },
    shellRssKiB: {
        minimum: Math.min(...rss),
        maximum: Math.max(...rss),
        firstQuarterMedian,
        lastQuarterMedian,
        medianChange: lastQuarterMedian - firstQuarterMedian,
        regressionSlopePerHour: slopeKiBPerHour,
        monotonicallyGrowing,
    },
    passed: pluginSetStable && actorStable && !monotonicallyGrowing,
};
print(JSON.stringify(document, null, 2));
if (!document.passed)
    System.exit(1);

function readJson(path) {
    return JSON.parse(readText(path));
}

function readMemory(path) {
    const lines = readText(path).trim().split('\n').slice(1);
    const result = [];
    for (const line of lines) {
        const fields = line.split('\t');
        if (fields.length !== 6 || fields[5] !== 'gnome-shell')
            continue;
        const seconds = Number(fields[0]);
        const rssKiB = Number(fields[3]);
        if (Number.isFinite(seconds) && Number.isFinite(rssKiB) && rssKiB > 0)
            result.push({seconds, rssKiB});
    }
    return result;
}

function readText(path) {
    const file = Gio.File.new_for_path(path);
    const size = file.query_info(
        Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
        Gio.FileQueryInfoFlags.NONE,
        null).get_size();
    if (size > MAX_INPUT_BYTES)
        throw new Error(`Steady-state input exceeds ${MAX_INPUT_BYTES} bytes`);
    const [, bytes] = file.load_contents(null);
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

function regressionSlope(samples) {
    const first = samples[0].seconds;
    const x = samples.map(sample => sample.seconds - first);
    const y = samples.map(sample => sample.rssKiB);
    const meanX = mean(x);
    const meanY = mean(y);
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < samples.length; index++) {
        numerator += (x[index] - meanX) * (y[index] - meanY);
        denominator += (x[index] - meanX) ** 2;
    }
    return denominator === 0 ? 0 : numerator / denominator;
}

function median(values) {
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? (ordered[middle - 1] + ordered[middle]) / 2
        : ordered[middle];
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
