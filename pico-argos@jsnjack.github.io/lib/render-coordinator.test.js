// SPDX-License-Identifier: GPL-3.0-or-later

import {RenderCoordinator} from './render-coordinator.js';

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

    fire() {
        if (this.sources.size !== 1)
            throw new Error(`Expected one render source, found ${this.sources.size}`);
        const [id, source] = this.sources.entries().next().value;
        this.sources.delete(id);
        source.callback();
        return source.delayMs;
    }

    nextDelay() {
        return this.sources.values().next().value?.delayMs ?? null;
    }

    lastId = 0;
    sources = new Map();
}

const clock = new FakeClock();
const timer = new FakeTimer();
const applied = [];
const batches = [];
const coordinator = new RenderCoordinator({
    clock,
    timer,
    apply: (plugin, presentation) => {
        applied.push([plugin.id, presentation.value]);
        return 1;
    },
    onBatch: batch => batches.push(batch),
});
const alpha = {id: 'alpha'};
const beta = {id: 'beta'};
for (let value = 0; value < 10_000; value++)
    coordinator.queue(alpha, {value}, value + 1);
coordinator.queue(beta, {value: 2}, 7);
if (timer.sources.size !== 1)
    throw new Error('Render coordinator created more than one pending source');
if (timer.fire() !== 0)
    throw new Error('Initial render batch was not queued at idle priority');
if (JSON.stringify(applied) !== JSON.stringify([['alpha', 9_999], ['beta', 2]]))
    throw new Error(`Render coordinator did not collapse to latest models: ${applied}`);
if (batches[0].pluginCount !== 2 || batches[0].writes !== 2)
    throw new Error('Render batch summary is incorrect');
if (batches[0].cycleId !== 10_000)
    throw new Error('Render batch did not retain its newest accepted cycle ID');

coordinator.queue(alpha, {value: 10_000});
if (timer.nextDelay() !== 100)
    throw new Error('Render coordinator did not enforce ten batches per second');
clock.valueUs = 100_000;
timer.fire();
coordinator.queue(alpha, {value: 10_001});
coordinator.remove('alpha');
if (timer.fire() !== 100)
    throw new Error('Expected the already-armed throttled source');
if (applied.length !== 3)
    throw new Error('Removed plugin retained pending rendering work');

coordinator.queue(alpha, {value: 10_002});
coordinator.stop();
if (timer.sources.size !== 0)
    throw new Error('Render coordinator stop leaked its source');
print('ok - render coordinator coalesces latest models and caps batch rate');
