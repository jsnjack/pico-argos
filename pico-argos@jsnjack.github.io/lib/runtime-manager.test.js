// SPDX-License-Identifier: GPL-3.0-or-later

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

const clock = new FakeClock();
const oneShotRunner = new FakeOneShotRunner();
const changes = [];
const events = [];
const added = [];
const removed = [];
const runtime = new RuntimeManager({
    clock,
    oneShotRunner,
    streamRunner: new FakeStreamRunner(),
    onChanges: (source, change, kind, _presentation, cycleId) =>
        changes.push([source.id, change, kind, cycleId]),
    onEvent: event => events.push(event),
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

const invalid = new Error('fixture failed');
invalid.kind = 'fixture';
oneShotRunner.outputs.push(invalid);
runtime.refreshOnOpen('fixture');
await settle();
if (changes.at(-1)[2] !== 'failure-changed')
    throw new Error('Runtime did not apply the manifest failure policy');

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

runtime.removePlugin('fixture');
runtime.stop();
if (JSON.stringify(removed) !== JSON.stringify(['fixture']))
    throw new Error('Runtime did not publish the removed plugin');
print('ok - runtime manager integrates scheduling, state, failures, and staleness');
