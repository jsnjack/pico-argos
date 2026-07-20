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
assertInvalid({command: ['../escape']}, /escapes/);
assertInvalid({timeoutMs: 5_000}, /less than/);
assertInvalid({maxStaleMs: 1_000}, /at least/);
assertInvalid({passEnvironment: ['TOKEN', 'TOKEN']}, /duplicated/);
assertInvalid({startupTimeoutMs: 1_000}, /mode-specific/);
assertInvalid({intervalMs: 1_000}, /mode-specific/, 'stream');

const ordered = [
    {...normalizedOneShot, id: 'z', position: 'right', order: 1},
    {...normalizedOneShot, id: 'b', position: 'left', order: 2},
    {...normalizedOneShot, id: 'a', position: 'left', order: 2},
].sort(compareManifests);
assertEqual(ordered.map(item => item.id), ['a', 'b', 'z'], 'manifest ordering');
print('ok - manifests are strictly validated, normalized, and ordered');
