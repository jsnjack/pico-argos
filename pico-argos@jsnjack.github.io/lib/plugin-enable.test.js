// SPDX-License-Identifier: GPL-3.0-or-later

import {
    isPluginEnabled,
    normalizeDisabledPluginIds,
    setPluginEnabled,
} from './plugin-enable.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

assertEqual(
    normalizeDisabledPluginIds(['zeta', 'alpha', 'zeta', '../bad', 42]),
    ['alpha', 'zeta'],
    'normalized disabled ids');
assertEqual(
    setPluginEnabled(['zeta'], 'alpha', false),
    ['alpha', 'zeta'],
    'disable plugin');
assertEqual(
    setPluginEnabled(['alpha', 'zeta'], 'alpha', true),
    ['zeta'],
    'enable plugin');
if (isPluginEnabled(['alpha'], 'alpha') || !isPluginEnabled(['alpha'], 'zeta'))
    throw new Error('Plugin enable lookup is incorrect');

const oversized = Array.from({length: 80}, (_value, index) => `plugin-${index}`);
if (normalizeDisabledPluginIds(oversized).length !== 64)
    throw new Error('Disabled plugin setting is not bounded');

print('ok - plugin enable state is validated, bounded, and deterministic');
