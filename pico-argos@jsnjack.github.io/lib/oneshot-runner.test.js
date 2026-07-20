// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {MonotonicClock} from './clock.js';
import {OneShotRunError, OneShotRunner} from './oneshot-runner.js';

const fixture = GLib.canonicalize_filename(
    'tests/fixtures/oneshot-fixture.js',
    GLib.get_current_dir());
const runner = new OneShotRunner({clock: new MonotonicClock()});

function manifest(mode, overrides = {}) {
    return {
        id: `fixture-${mode}`,
        mode: 'oneshot',
        command: ['gjs', '-m', fixture, mode],
        timeoutMs: 500,
        nice: null,
        passEnvironment: [],
        ...overrides,
    };
}

async function expectFailure(mode, expectedKind) {
    try {
        await runner.run(manifest(mode));
    } catch (error) {
        if (!(error instanceof OneShotRunError) || error.kind !== expectedKind)
            throw new Error(`${mode} failed as ${error.kind ?? error}: ${error.message}`);
        return error;
    }
    throw new Error(`${mode} unexpectedly succeeded`);
}

const constant = await runner.run(manifest('constant'));
if (!constant.raw.includes('"text":"ok"'))
    throw new Error('Runner did not retain valid stdout');
const chunked = await runner.run(manifest('chunked'));
if (chunked.raw !== constant.raw)
    throw new Error('Runner changed output split across chunks');

const exact = await runner.run(manifest('exact-limit'));
if (exact.stdoutBytes !== 64 * 1_024)
    throw new Error('Runner rejected exactly 64 KiB of stdout');
await expectFailure('stdout-flood', 'stdout-limit');
await expectFailure('stderr-flood', 'stderr-limit');
await expectFailure('invalid-utf8', 'utf8');
const nonzero = await expectFailure('nonzero', 'nonzero-exit');
if (nonzero.stderr !== 'fixture failure')
    throw new Error(`Runner retained unexpected stderr: ${JSON.stringify(nonzero.stderr)}`);
await expectFailure('timeout', 'timeout');

const environment = JSON.parse((await runner.run(manifest('environment'), {
    menuOpen: true,
})).raw);
if (environment.protocol !== '1' || environment.menuOpen !== 'true' ||
    environment.pluginId !== 'fixture-environment')
    throw new Error('Runner did not construct the plugin protocol environment');

const cancellation = runner.run(manifest('timeout', {id: 'cancel-fixture'}));
runner.cancel('cancel-fixture');
try {
    await cancellation;
    throw new Error('Cancelled runner unexpectedly succeeded');
} catch (error) {
    if (!(error instanceof OneShotRunError) || error.kind !== 'cancelled')
        throw error;
}
print('ok - one-shot runner enforces pipe, timeout, exit, and UTF-8 bounds');
