// SPDX-License-Identifier: GPL-3.0-or-later

import {DistinctText} from './state.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
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
