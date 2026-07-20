// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {MonotonicClock} from './clock.js';
import {parseProtocolMessage} from './protocol.js';
import {StreamRunError, StreamRunner} from './stream-runner.js';

const fixture = GLib.canonicalize_filename(
    'tests/fixtures/stream-fixture.js',
    GLib.get_current_dir());
const runner = new StreamRunner({clock: new MonotonicClock()});

function manifest(mode, overrides = {}) {
    return {
        id: `fixture-${mode}`,
        mode: 'stream',
        command: ['gjs', '-m', fixture, mode],
        startupTimeoutMs: 300,
        heartbeatTimeoutMs: 0,
        maxMessagesPerSecond: 2,
        maxBytesPerMinute: 65_536,
        nice: null,
        passEnvironment: [],
        ...overrides,
    };
}

async function expectFailure(mode, expectedKind, overrides = {}, callbacks = {}) {
    try {
        await runner.run(manifest(mode, overrides), callbacks);
    } catch (error) {
        if (!(error instanceof StreamRunError) || error.kind !== expectedKind)
            throw new Error(`${mode} failed as ${error.kind ?? error}: ${error.message}`);
        return error;
    }
    throw new Error(`${mode} unexpectedly completed`);
}

const kinds = [];
await expectFailure('messages', 'stdout-eof', {}, {
    onMessage: raw => {
        const message = parseProtocolMessage(raw, {allowHeartbeat: true});
        kinds.push(message.kind);
        return message;
    },
});
if (JSON.stringify(kinds) !== JSON.stringify(['snapshot', 'heartbeat']))
    throw new Error(`Runner did not parse complete stream messages: ${JSON.stringify(kinds)}`);

let splitText = null;
await expectFailure('split-utf8', 'stdout-eof', {}, {
    onMessage: raw => {
        const message = parseProtocolMessage(raw, {allowHeartbeat: true});
        splitText = message.snapshot.panel.text;
        return message;
    },
});
if (splitText !== '€')
    throw new Error('Runner did not preserve UTF-8 split across pipe reads');

await expectFailure('partial', 'partial-line');
await expectFailure('message-flood', 'message-rate');
await expectFailure('byte-flood', 'byte-rate');
await expectFailure('invalid-utf8', 'utf8');
await expectFailure('startup-timeout', 'startup-timeout');
await expectFailure('heartbeat-timeout', 'heartbeat-timeout', {
    heartbeatTimeoutMs: 200,
});
const stderrFlood = await expectFailure('stderr-flood', 'stderr-rate');
if (stderrFlood.stderr.length !== 8 * 1_024)
    throw new Error('Runner did not retain the bounded stream stderr tail');

const cancellation = runner.run(manifest('cancel', {id: 'cancel-stream'}));
runner.cancel('cancel-stream');
try {
    await cancellation;
    throw new Error('Cancelled stream unexpectedly completed');
} catch (error) {
    if (!(error instanceof StreamRunError) || error.kind !== 'cancelled')
        throw error;
}
print('ok - stream runner supervises framing, liveness, rates, and cancellation');
