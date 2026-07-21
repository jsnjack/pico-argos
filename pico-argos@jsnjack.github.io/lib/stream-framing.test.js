// SPDX-License-Identifier: GPL-3.0-or-later

import {
    StreamFramer,
    StreamLimitError,
    StreamRestartPolicy,
    StreamStderr,
    TokenBucket,
} from './stream-framing.js';

const encoder = new TextEncoder();

function expectKind(callback, kind) {
    try {
        callback();
    } catch (error) {
        if (error instanceof StreamLimitError && error.kind === kind)
            return;
        throw error;
    }
    throw new Error(`Expected ${kind} limit failure`);
}

const split = new StreamFramer({
    maxMessagesPerSecond: 10,
    maxBytesPerMinute: 65_536,
    nowUs: 0,
});
if (split.push(new Uint8Array([0xe2]), 0).length !== 0)
    throw new Error('Framer emitted an incomplete UTF-8 sequence');
const lines = split.push(new Uint8Array([
    0x82, 0xac, 0x0a,
    ...encoder.encode('two\npartial'),
]), 0);
if (JSON.stringify(lines) !== JSON.stringify(['€', 'two']))
    throw new Error(`Unexpected split stream lines: ${JSON.stringify(lines)}`);
expectKind(() => split.finish(), 'partial-line');

const multiple = new StreamFramer({
    maxMessagesPerSecond: 2,
    maxBytesPerMinute: 65_536,
    nowUs: 0,
});
if (multiple.push(encoder.encode('one\ntwo\n'), 0).length !== 2)
    throw new Error('Framer did not return multiple messages from one read');
if (multiple.push(encoder.encode('three\n'), 500_000)[0] !== 'three')
    throw new Error('Message bucket did not continuously refill');
expectKind(() => multiple.push(encoder.encode('four\n'), 500_000), 'message-rate');

const bytes = new StreamFramer({
    maxMessagesPerSecond: 10,
    maxBytesPerMinute: 65_536,
    nowUs: 0,
});
bytes.push(new Uint8Array(65_536), 0);
expectKind(() => bytes.push(new Uint8Array([1]), 0), 'byte-rate');

const line = new StreamFramer({
    maxMessagesPerSecond: 10,
    maxBytesPerMinute: 1_048_576,
    nowUs: 0,
});
const exactLine = 'x'.repeat(65_535);
if (line.push(encoder.encode(`${exactLine}\n`), 0)[0] !== exactLine)
    throw new Error('Framer rejected an exact 64-KiB line');
expectKind(() => line.push(encoder.encode(`${'x'.repeat(65_536)}\n`), 0), 'line-limit');

const stderr = new StreamStderr(0);
stderr.push(encoder.encode('a'.repeat(8_000)), 0);
stderr.push(encoder.encode('b'.repeat(1_000)), 0);
if (stderr.text().length !== 8 * 1_024 || !stderr.text().endsWith('b'.repeat(1_000)))
    throw new Error('Stream stderr did not retain a bounded rolling tail');
expectKind(() => stderr.push(new Uint8Array(64 * 1_024), 0), 'stderr-rate');

const bucket = new TokenBucket(2, 2, 0);
if (!bucket.consume(2, 0) || bucket.consume(1, 0) || !bucket.consume(1, 500_000))
    throw new Error('Fractional token refill is incorrect');

const policy = new StreamRestartPolicy();
const expected = [1, 2, 4, 8, 16, 32, 60, 60, 60];
for (const delay of expected) {
    const result = policy.fail(0);
    if (result.delayMs !== delay * 1_000 || result.locked)
        throw new Error(`Unexpected stream restart delay: ${JSON.stringify(result)}`);
}
if (!policy.fail(0).locked)
    throw new Error('Stream did not lock after ten consecutive failures');
policy.reset();
policy.markHealthy(0);
if (policy.fail(5 * 60 * 1_000_000).delayMs !== 1_000)
    throw new Error('Five healthy minutes did not reset stream backoff');
print('ok - stream framing bounds UTF-8, lines, rates, stderr, and restarts');
