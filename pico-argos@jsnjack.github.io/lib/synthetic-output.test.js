// SPDX-License-Identifier: GPL-3.0-or-later

import {SyntheticOutput, SYNTHETIC_MODES} from './synthetic-output.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const output = new SyntheticOutput();
const constant = output.next(SYNTHETIC_MODES.CONSTANT);
const changing = output.next(SYNTHETIC_MODES.CHANGING);
const spawn = output.next(SYNTHETIC_MODES.SPAWN);

assertEqual(constant, 'constant 000000', 'constant output');
assertEqual(changing, 'changing 000001', 'changing output');
assertEqual(spawn, 'spawn    000000', 'spawn output');
assertEqual(constant.length, changing.length, 'constant and changing widths');
assertEqual(changing.length, spawn.length, 'changing and spawn widths');

output.reset();
assertEqual(output.next(SYNTHETIC_MODES.CHANGING), 'changing 000001', 'reset output');
print('ok - synthetic output is deterministic and fixed width');
