// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {RuntimeManager} from './runtime-manager.js';

class FakeClock {
    nowUs() {
        return this.valueUs;
    }

    valueUs = 0;
}

class FakeOneShotRunner {
    async run() {
        const next = this.outputs.shift();
        if (next instanceof Error)
            throw next;
        return {raw: next};
    }

    cancel() {}
    cancelAll() {}

    outputs = [];
}

class FakeStreamRunner {
    run() {
        return new Promise(() => {});
    }

    cancel() {}
    cancelAll() {}
}

function plugin(overrides = {}) {
    return {
        id: 'fixture',
        directory: '/plugins/fixture',
        manifest: {
            id: 'fixture',
            mode: 'oneshot',
            command: ['/plugins/fixture/run'],
            intervalMs: 10_000,
            timeoutMs: 1_000,
            refreshOnOpen: true,
            position: 'right',
            order: 0,
            nice: null,
            reserveTextChars: 8,
            passEnvironment: [],
            failurePolicy: 'show-error',
            maxStaleMs: 10_000,
            ...overrides,
        },
    };
}

function raw(text, whitespace = false) {
    const value = {
        version: 1,
        type: 'snapshot',
        panel: {text},
        menu: [],
    };
    return whitespace ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

async function settle() {
    for (let index = 0; index < 20; index++)
        await Promise.resolve();
}

function settleIdle() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const clock = new FakeClock();
const oneShotRunner = new FakeOneShotRunner();
const changes = [];
const events = [];
const phases = [];
const added = [];
const removed = [];
const runtime = new RuntimeManager({
    clock,
    oneShotRunner,
    streamRunner: new FakeStreamRunner(),
    onChanges: (source, change, kind, _presentation, cycleId) =>
        changes.push([source.id, change, kind, cycleId]),
    onEvent: event => events.push(event),
    onPhase: (name, durationUs, pluginId) =>
        phases.push([name, durationUs, pluginId]),
    onPluginAdded: source => added.push(source.id),
    onPluginRemoved: source => removed.push(source.id),
});
runtime.setPlugin(plugin());
runtime.start();
if (JSON.stringify(added) !== JSON.stringify(['fixture']))
    throw new Error('Runtime did not publish the added plugin');

oneShotRunner.outputs.push(raw('ok'));
runtime.refreshOnOpen('fixture');
await settle();
if (changes.length !== 1 || changes[0][2] !== 'changed')
    throw new Error('Runtime did not publish the initial semantic snapshot');

oneShotRunner.outputs.push(raw('ok'));
runtime.refreshOnOpen('fixture');
await settle();
if (changes.length !== 1 || runtime.snapshot().plugins[0].rawNoOps !== 1)
    throw new Error('Runtime did not suppress identical one-shot output');
if (runtime.snapshot().plugins[0].lastCycleId !== 2)
    throw new Error('Raw no-op did not receive an accepted-snapshot cycle ID');

oneShotRunner.outputs.push(raw('ok', true));
runtime.refreshOnOpen('fixture');
await settle();
if (changes.length !== 1 || runtime.snapshot().plugins[0].semanticNoOps !== 1)
    throw new Error('Runtime did not suppress a semantic no-op');
if (runtime.snapshot().plugins[0].lastCycleId !== 3)
    throw new Error('Semantic no-op did not receive an accepted-snapshot cycle ID');
const acceptedEvents = events.filter(event => event.kind === 'snapshot-accepted');
if (JSON.stringify(acceptedEvents.map(event => event.cycleId)) !== '[1,2,3]')
    throw new Error('Accepted snapshot cycle IDs are not monotonically increasing');
for (const name of ['raw-compare', 'parse', 'validate', 'semantic-diff']) {
    if (!phases.some(phase => phase[0] === name && phase[2] === 'fixture'))
        throw new Error(`Runtime omitted the ${name} phase measurement`);
}

const invalid = new Error('fixture failed');
invalid.kind = 'fixture';
invalid.stderr = 'private child output';
oneShotRunner.outputs.push(invalid);
runtime.refreshOnOpen('fixture');
await settle();
if (changes.at(-1)[2] !== 'failure-changed')
    throw new Error('Runtime did not apply the manifest failure policy');
const sanitizedFailure = runtime.snapshot().plugins[0].lastFailure;
if (JSON.stringify(sanitizedFailure) !== '{"kind":"fixture"}' ||
    JSON.stringify(runtime.snapshot()).includes('private child output'))
    throw new Error('Runtime diagnostics exposed retained child failure output');

clock.valueUs = 11_000_000;
runtime.tickStaleness();
if (changes.at(-1)[2] !== 'stale-changed')
    throw new Error('Runtime did not apply the coarse staleness transition');

runtime.setPlugin(plugin({reserveTextChars: 1}));
oneShotRunner.outputs.push(raw('ok'));
runtime.refreshOnOpen('fixture');
await settle();
if (runtime.snapshot().plugins[0].lastFailure === null)
    throw new Error('Manifest replacement did not revalidate reserved text');

runtime.setPlugin(plugin({reserveTextChars: 1}));
oneShotRunner.outputs.push(JSON.stringify({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: [],
}));
runtime.refreshOnOpen('fixture');
await settle();
if (runtime.snapshot().plugins[0].lastFailure !== null)
    throw new Error('A hidden panel incorrectly violated reserveTextChars');

runtime.setPlugin(plugin({refreshOnOpen: false}));
if (runtime.refreshOnOpen('fixture'))
    throw new Error('Runtime bypassed the manifest menu-open refresh policy');
oneShotRunner.outputs.push(raw('manual'));
if (!runtime.refreshNow('fixture'))
    throw new Error('Runtime rejected an explicit one-shot refresh');
await settle();
if (runtime.snapshot().plugins[0].lastFailure !== null)
    throw new Error('Explicit one-shot refresh did not recover valid state');

runtime.setPlugin(plugin({
    mode: 'stream',
    startupTimeoutMs: 5_000,
    heartbeatTimeoutMs: 0,
    maxMessagesPerSecond: 2,
    maxBytesPerMinute: 262_144,
}));
await settleIdle();
if (runtime.snapshot().plugins[0].processState !== 'starting')
    throw new Error('Replacement stream did not enter starting health state');
runtime.setPlugin(plugin({refreshOnOpen: false}));
if (runtime.snapshot().plugins[0].processState !== 'idle' ||
    runtime.snapshot().plugins[0].mode !== 'oneshot') {
    throw new Error('Mode replacement retained stale stream health state');
}

runtime.removePlugin('fixture');
runtime.destroy();
if (JSON.stringify(removed) !== JSON.stringify(['fixture']))
    throw new Error('Runtime did not publish the removed plugin');
if (runtime.snapshot().plugins.length !== 0 ||
    runtime.snapshot().oneShot.plugins.length !== 0 ||
    runtime.snapshot().streams.plugins.length !== 0)
    throw new Error('Runtime destroy retained plugin or scheduler state');
print('ok - runtime manager integrates scheduling, state, failures, and staleness');
