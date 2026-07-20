// SPDX-License-Identifier: GPL-3.0-or-later

import {DistinctText, StateStore} from './state.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const cases = [
    ['identical text performs no writes', () => {
        let writes = 0;
        const text = new DistinctText('constant 000000', () => writes++);

        for (let index = 0; index < 10_000; index++)
            assertEqual(text.apply('constant 000000'), false, 'apply result');

        assertEqual(writes, 0, 'writer calls');
    }],
    ['changed text performs one write', () => {
        const values = [];
        const text = new DistinctText('changing 000000', value => values.push(value));

        assertEqual(text.apply('changing 000001'), true, 'first apply');
        assertEqual(text.apply('changing 000001'), false, 'second apply');
        assertEqual(text.value, 'changing 000001', 'stored value');
        assertEqual(values.length, 1, 'writer calls');
    }],
    ['raw and semantic no-ops stop before visible changes', () => {
        let parseCount = 0;
        const parser = raw => {
            parseCount++;
            const value = JSON.parse(raw);
            return {
                kind: 'snapshot',
                snapshot: Object.freeze({
                    panel: Object.freeze({
                        visible: true,
                        text: value.text,
                        icon: null,
                        appearance: 'normal',
                        accessibleName: null,
                        severity: 'normal',
                    }),
                    menu: Object.freeze([]),
                }),
            };
        };
        const store = new StateStore(parser);
        const raw = '{"text":"same"}';

        assertEqual(store.accept('test', raw).kind, 'changed', 'initial state');
        assertEqual(store.accept('test', raw).kind, 'raw-no-op', 'raw no-op');
        assertEqual(store.accept('test', '{ "text": "same" }').kind,
            'semantic-no-op', 'semantic no-op');
        assertEqual(parseCount, 2, 'parse calls');
    }],
    ['snapshot changes identify only changed fields and keyed menu entries', () => {
        const parser = raw => ({kind: 'snapshot', snapshot: JSON.parse(raw)});
        const store = new StateStore(parser);
        const first = {
            panel: {visible: true, text: '1', icon: null, appearance: 'normal', accessibleName: null, severity: 'normal'},
            menu: [
                {id: 'a', kind: 'label', text: 'Alpha'},
                {id: 'b', kind: 'link', text: 'Beta', uri: 'https://example.com/b'},
            ],
        };
        const second = {
            panel: {...first.panel, text: '2'},
            menu: [
                {id: 'b', kind: 'link', text: 'Changed', uri: 'https://example.com/b'},
                {id: 'c', kind: 'separator'},
            ],
        };
        store.accept('test', JSON.stringify(first));
        const result = store.accept('test', JSON.stringify(second));

        assertEqual(result.changes.panel, {fields: {text: '2'}}, 'panel changes');
        assertEqual(result.changes.menu.removed, ['a'], 'removed menu IDs');
        assertEqual(result.changes.menu.added, [{item: second.menu[1], index: 1}], 'added menu items');
        assertEqual(result.changes.menu.updated, [{id: 'b', changes: {fields: {text: 'Changed'}}}], 'updated menu items');
        assertEqual(result.changes.menu.order, ['b', 'c'], 'menu order');
    }],
    ['failure and staleness policies transition only once', () => {
        const parser = raw => ({kind: 'snapshot', snapshot: JSON.parse(raw)});
        const store = new StateStore(parser);
        const snapshot = {
            panel: {visible: true, text: 'ok', icon: null, appearance: 'normal', accessibleName: null, severity: 'normal'},
            menu: [],
        };
        const raw = JSON.stringify(snapshot);
        store.accept('test', raw);

        assertEqual(store.applyFailure('test', 'keep-last').kind,
            'failure-no-op', 'keep-last failure');
        assertEqual(store.applyFailure('test', 'hide').kind,
            'failure-changed', 'hide transition');
        assertEqual(store.applyFailure('test', 'hide').kind,
            'failure-no-op', 'repeated hide');
        assertEqual(store.get('test'), snapshot, 'last valid snapshot');
        assertEqual(store.getEffective('test').panel, null, 'hidden effective panel');

        const recovery = store.accept('test', raw);
        assertEqual(recovery.kind, 'changed', 'recovery from same raw output');
        assertEqual(recovery.changes.panel, {replace: snapshot.panel}, 'recovery panel');
        assertEqual(store.setStale('test', true).kind, 'stale-changed', 'stale transition');
        assertEqual(store.setStale('test', true).kind, 'stale-no-op', 'repeated stale');
        assertEqual(store.accept('test', raw).changes.stale, false, 'stale recovery');
    }],
];

for (const [name, test] of cases) {
    try {
        test();
        print(`ok - ${name}`);
    } catch (error) {
        printerr(`not ok - ${name}: ${error.message}`);
        throw error;
    }
}
