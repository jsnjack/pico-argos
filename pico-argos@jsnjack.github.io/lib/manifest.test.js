// SPDX-License-Identifier: GPL-3.0-or-later

import {compareManifests, ManifestError, validateManifest} from './manifest.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertInvalid(overrides, pattern, mode = 'oneshot') {
    const value = mode === 'oneshot'
        ? {...oneShot, ...overrides}
        : {...stream, ...overrides};
    try {
        validateManifest(value, '/tmp/plugins/test', 'test');
    } catch (error) {
        if (!(error instanceof ManifestError))
            throw error;
        if (!pattern.test(error.message))
            throw new Error(`Unexpected manifest error: ${error.message}`);
        return;
    }
    throw new Error(`Expected invalid manifest: ${JSON.stringify(value)}`);
}

const common = {
    manifestVersion: 1,
    id: 'test',
    command: ['./run', '--compact'],
    position: 'right',
    order: 10,
    passEnvironment: ['TOKEN'],
    failurePolicy: 'keep-last',
    maxStaleMs: 10_000,
};
const oneShot = {
    ...common,
    mode: 'oneshot',
    intervalMs: 5_000,
    timeoutMs: 4_000,
    refreshOnOpen: true,
};
const stream = {
    ...common,
    mode: 'stream',
    maxStaleMs: null,
};

const normalizedOneShot = validateManifest(oneShot, '/tmp/plugins/test', 'test');
assertEqual(normalizedOneShot.command[0], '/tmp/plugins/test/run', 'resolved executable');
assertEqual(normalizedOneShot.nice, 10, 'default niceness');
assertEqual(normalizedOneShot.reserveTextChars, 0, 'default reservation');
if (!Object.isFrozen(normalizedOneShot) || !Object.isFrozen(normalizedOneShot.command))
    throw new Error('Normalized manifest must be immutable');

const normalizedStream = validateManifest(stream, '/tmp/plugins/test', 'test');
assertEqual(normalizedStream.startupTimeoutMs, 5_000, 'startup default');
assertEqual(normalizedStream.heartbeatTimeoutMs, 0, 'heartbeat default');
assertEqual(normalizedStream.maxMessagesPerSecond, 2, 'message default');
assertEqual(normalizedStream.maxBytesPerMinute, 262_144, 'byte default');

assertInvalid({id: 'other'}, /directory/);
assertInvalid({manifestVersion: 2}, /version/);
assertInvalid({id: 'Invalid'}, /ID/);
assertInvalid({command: ['../escape']}, /escapes/);
assertInvalid({command: []}, /1 through 32/);
assertInvalid({command: Array(33).fill('x')}, /1 through 32/);
assertInvalid({command: ['x'.repeat(4_097)]}, /4096/);
assertInvalid({command: Array(5).fill('x'.repeat(4_000))}, /16 KiB/);
assertInvalid({command: ['./run', 'bad\0argument']}, /NUL/);
assertInvalid({intervalMs: 999}, /1000/);
assertInvalid({intervalMs: 86_400_001}, /86400000/);
assertInvalid({timeoutMs: 99}, /100/);
assertInvalid({timeoutMs: 30_001}, /30000/);
assertInvalid({timeoutMs: 5_000}, /less than/);
assertInvalid({maxStaleMs: 1_000}, /at least/);
assertInvalid({maxStaleMs: 604_800_001}, /604800000/);
assertInvalid({nice: 20}, /0 through 19/);
assertInvalid({reserveTextChars: 129}, /0 through 128/);
assertInvalid({order: 1.5}, /integer/);
assertInvalid({passEnvironment: ['TOKEN', 'TOKEN']}, /duplicated/);
assertInvalid({passEnvironment: Array.from({length: 17}, (_value, index) => `E${index}`)}, /at most 16/);
assertInvalid({passEnvironment: ['PATH']}, /reserved/);
assertInvalid({passEnvironment: ['PICO_ARGOS_PROTOCOL']}, /reserved/);
assertInvalid({startupTimeoutMs: 1_000}, /mode-specific/);
assertInvalid({intervalMs: 1_000}, /mode-specific/, 'stream');
assertInvalid({startupTimeoutMs: 99}, /100/, 'stream');
assertInvalid({startupTimeoutMs: 30_001}, /30000/, 'stream');
assertInvalid({heartbeatTimeoutMs: 999}, /1000/, 'stream');
assertInvalid({heartbeatTimeoutMs: 300_001}, /300000/, 'stream');
assertInvalid({maxMessagesPerSecond: 0}, /1 through 10/, 'stream');
assertInvalid({maxMessagesPerSecond: 11}, /1 through 10/, 'stream');
assertInvalid({maxBytesPerMinute: 65_535}, /65536/, 'stream');
assertInvalid({maxBytesPerMinute: 1_048_577}, /1048576/, 'stream');

const ordered = [
    {...normalizedOneShot, id: 'z', position: 'right', order: 1},
    {...normalizedOneShot, id: 'b', position: 'left', order: 2},
    {...normalizedOneShot, id: 'a', position: 'left', order: 2},
].sort(compareManifests);
assertEqual(ordered.map(item => item.id), ['a', 'b', 'z'], 'manifest ordering');
print('ok - manifests are strictly validated, normalized, and ordered');
