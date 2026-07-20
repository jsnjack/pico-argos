// SPDX-License-Identifier: GPL-3.0-or-later

import {StreamSupervisor} from './stream-supervisor.js';

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

    fireDelay(delayMs) {
        const match = [...this.sources].find(([_id, source]) =>
            source.delayMs === delayMs);
        if (match === undefined)
            throw new Error(`No timer with delay ${delayMs}`);
        const [id, source] = match;
        this.sources.delete(id);
        source.callback();
    }

    lastId = 0;
    sources = new Map();
}

class FakeRunner {
    run(manifest, callbacks) {
        this.starts.push(manifest.id);
        return new Promise((resolve, reject) => {
            this.active.set(manifest.id, {callbacks, resolve, reject});
        });
    }

    cancel(pluginId) {
        this.cancellations.push(pluginId);
        this.active.get(pluginId)?.reject({kind: 'cancelled'});
        this.active.delete(pluginId);
    }

    cancelAll() {
        for (const pluginId of [...this.active.keys()])
            this.cancel(pluginId);
    }

    starts = [];
    cancellations = [];
    active = new Map();
}

function plugin(id, order) {
    return {
        id,
        directory: `/plugins/${id}`,
        manifest: {
            id,
            mode: 'stream',
            position: 'right',
            order,
        },
    };
}

async function settle() {
    for (let index = 0; index < 10; index++)
        await Promise.resolve();
}

const timer = new FakeTimer();
const runner = new FakeRunner();
const messages = [];
const supervisor = new StreamSupervisor({
    clock: new FakeClock(),
    runner,
    timer,
    onMessage: (source, raw, context) => {
        messages.push([source.id, raw, context]);
        return context;
    },
});
for (let index = 0; index < 5; index++)
    supervisor.setPlugin(plugin(`stream-${index}`, index));
supervisor.start();
for (let index = 0; index < 4; index++)
    timer.fireDelay(0);
if (JSON.stringify(runner.starts) !==
    JSON.stringify(['stream-0', 'stream-1', 'stream-2', 'stream-3']))
    throw new Error(`Stream starts were not ordered and serialized: ${runner.starts}`);
if (supervisor.snapshot().active !== 4 ||
    supervisor.snapshot().plugins.find(state => state.id === 'stream-4').admitted)
    throw new Error('Supervisor did not enforce the four-stream limit');

const messageContext = {runId: 7, sequence: 3, kind: 'snapshot'};
const returnedContext = runner.active.get('stream-0').callbacks.onMessage(
    'snapshot', messageContext);
if (returnedContext !== messageContext || messages[0][2] !== messageContext)
    throw new Error('Stream supervisor dropped message correlation context');
if (JSON.stringify(messages) !==
    JSON.stringify([['stream-0', 'snapshot', messageContext]]))
    throw new Error('Supervisor did not forward a current stream message');
runner.active.get('stream-0').reject({kind: 'fixture'});
runner.active.delete('stream-0');
await settle();
if (![...timer.sources.values()].some(source => source.delayMs === 1_000))
    throw new Error('Supervisor did not schedule initial restart backoff');
supervisor.removePlugin('stream-0');
timer.fireDelay(0);
if (!runner.starts.includes('stream-4'))
    throw new Error('Supervisor did not admit the next stream after removal');

supervisor.setPlugin(plugin('stream-1', 1));
if (!runner.cancellations.includes('stream-1'))
    throw new Error('Manifest replacement did not cancel the old direct child');
await settle();
timer.fireDelay(0);
if (runner.starts.filter(id => id === 'stream-1').length !== 2)
    throw new Error('Manifest replacement did not relaunch the stream');

supervisor.stop();
if (timer.sources.size !== 0)
    throw new Error('Supervisor stop leaked launch or restart sources');
if (runner.active.size !== 0)
    throw new Error('Supervisor stop left active direct children');
print('ok - stream supervisor serializes four children and bounded restarts');
