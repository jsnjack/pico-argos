// SPDX-License-Identifier: GPL-3.0-or-later

import {OneShotScheduler} from './oneshot-scheduler.js';

class FakeClock {
    nowUs() {
        return this.valueUs;
    }

    valueUs = 0;
}

class FakeTimer {
    schedule(delayMs, callback) {
        const id = ++this.lastId;
        this.sources.set(id, {delayMs, callback});
        return id;
    }

    cancel(id) {
        this.sources.delete(id);
    }

    lastId = 0;
    sources = new Map();
}

function manifest(id, intervalMs = 1_000) {
    return {
        id,
        mode: 'oneshot',
        intervalMs,
        refreshOnOpen: true,
    };
}

async function settle() {
    for (let index = 0; index < 10; index++)
        await Promise.resolve();
}

const clock = new FakeClock();
const timer = new FakeTimer();
const starts = [];
const completions = [];
const scheduler = new OneShotScheduler({
    clock,
    timer,
    run: (plugin, request) => {
        starts.push({id: plugin.id, ...request});
        return new Promise(resolve => completions.push(resolve));
    },
});
scheduler.setPlugin(manifest('alpha'));
scheduler.setPlugin(manifest('beta'));
scheduler.setPlugin(manifest('hourly', 3_600_000));
if (scheduler.snapshot().plugins.find(plugin => plugin.id === 'hourly').nextDueUs > 1_000_000)
    throw new Error('Long-interval plugin was not phased into the startup window');
scheduler.removePlugin('hourly');
scheduler.start();
if (timer.sources.size !== 1)
    throw new Error('Scheduler did not retain exactly one deadline source');

clock.valueUs = 2_000_000;
scheduler.poll();
await settle();
if (starts.length !== 1)
    throw new Error('Scheduler did not serialize the first due run');
const snapshotWhileRunning = scheduler.snapshot();
const firstId = starts[0].id;
const secondId = firstId === 'alpha' ? 'beta' : 'alpha';
const queued = snapshotWhileRunning.plugins.find(plugin => plugin.id === secondId);
if (queued.pending?.reason !== 'periodic')
    throw new Error('Second due plugin did not remain in the bounded queue');

if (!scheduler.requestRefresh(secondId))
    throw new Error('Refresh-on-open request was not accepted');
if (scheduler.snapshot().plugins.find(plugin => plugin.id === secondId)
    .pending?.reason !== 'refresh')
    throw new Error('Refresh work did not take priority over periodic work');
completions.shift()();
await settle();
if (starts.length !== 2 || starts[1].id !== secondId || starts[1].reason !== 'refresh')
    throw new Error('Refresh work was not dispatched before periodic work');

scheduler.requestRefresh(secondId);
scheduler.requestRefresh(secondId);
if (scheduler.snapshot().plugins.find(plugin => plugin.id === secondId)
    .pending === null)
    throw new Error('Active refresh did not coalesce into one pending token');
completions.shift()();
await settle();
if (starts.length !== 3)
    throw new Error('Coalesced active refresh did not run once');
completions.shift()();
await settle();

clock.valueUs = 20_000_000;
scheduler.poll();
await settle();
const resumed = scheduler.snapshot();
if (!resumed.plugins.every(plugin => plugin.nextDueUs > clock.valueUs))
    throw new Error('Resume did not advance every deadline into the future');
if (!resumed.plugins.some(plugin => plugin.skipped > 0))
    throw new Error('Resume did not count skipped deadlines');

scheduler.destroy();
if (timer.sources.size !== 0)
    throw new Error('Scheduler stop leaked its deadline source');
if (scheduler.snapshot().plugins.length !== 0 ||
    scheduler.snapshot().activePluginId !== null)
    throw new Error('Scheduler destroy retained plugin state');

const manualTimer = new FakeTimer();
const manualStarts = [];
const manualCompletions = [];
const manualScheduler = new OneShotScheduler({
    clock: new FakeClock(),
    timer: manualTimer,
    run: (plugin, request) => {
        manualStarts.push({id: plugin.id, ...request});
        return new Promise(resolve => manualCompletions.push(resolve));
    },
});
manualScheduler.setPlugin({...manifest('manual-alpha'), refreshOnOpen: false});
manualScheduler.setPlugin({...manifest('manual-beta'), refreshOnOpen: false});
manualScheduler.start();
if (manualScheduler.requestRefresh('manual-alpha'))
    throw new Error('Menu-open refresh bypassed a disabled manifest policy');
if (!manualScheduler.requestManual('manual-alpha'))
    throw new Error('Explicit refresh was not accepted');
await settle();
manualScheduler.requestManual('manual-alpha');
manualScheduler.requestManual('manual-beta');
manualCompletions.shift()();
await settle();
if (manualStarts[0].menuOpen || manualStarts[1].id !== 'manual-beta')
    throw new Error('Explicit refresh lost menu state or starved pending peer work');
manualCompletions.shift()();
await settle();
if (manualStarts[2].id !== 'manual-alpha')
    throw new Error('Coalesced explicit refresh did not run after its pending peer');
manualCompletions.shift()();
await settle();
manualScheduler.destroy();
print('ok - one-shot scheduler phases deadlines and serializes bounded work');
