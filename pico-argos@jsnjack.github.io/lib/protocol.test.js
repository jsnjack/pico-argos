// SPDX-License-Identifier: GPL-3.0-or-later

import {parseProtocolMessage, ProtocolError} from './protocol.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertInvalid(value, pattern, options = {}) {
    try {
        parseProtocolMessage(JSON.stringify(value), options);
    } catch (error) {
        if (!(error instanceof ProtocolError))
            throw error;
        if (!pattern.test(error.message))
            throw new Error(`Unexpected protocol error: ${error.message}`);
        return;
    }
    throw new Error(`Expected invalid protocol message: ${JSON.stringify(value)}`);
}

const valid = parseProtocolMessage(JSON.stringify({
    version: 1,
    type: 'snapshot',
    panel: {
        text: '2',
        icon: 'software-update-available-symbolic',
        appearance: 'compact',
        severity: 'critical',
    },
    menu: [
        {id: 'status', kind: 'label', text: 'Two alerts'},
        {id: 'sep', kind: 'separator'},
        {id: 'open', kind: 'link', text: 'Open alerts', uri: 'https://example.com/a'},
    ],
}));
assertEqual(valid.kind, 'snapshot', 'message kind');
assertEqual(valid.snapshot.panel.visible, true, 'visible default');
assertEqual(valid.snapshot.menu.length, 3, 'menu length');
if (!Object.isFrozen(valid.snapshot) || !Object.isFrozen(valid.snapshot.menu[0]))
    throw new Error('Validated semantic snapshot must be immutable');

assertEqual(parseProtocolMessage(
    '{"version":1,"type":"heartbeat"}',
    {allowHeartbeat: true}),
{kind: 'heartbeat'}, 'heartbeat');

assertInvalid({version: 1, type: 'heartbeat'}, /execution mode/);
assertInvalid({version: 2, type: 'snapshot', panel: null, menu: []}, /version/);
assertInvalid({version: 1, type: 'snapshot', panel: null, menu: [], typo: true}, /unknown/);
assertInvalid({version: 1, type: 'snapshot', panel: {visible: true}, menu: []}, /text or icon/);
assertInvalid({version: 1, type: 'snapshot', panel: {icon: 'test-symbolic'}, menu: []}, /accessible/);
assertInvalid({version: 1, type: 'snapshot', panel: {text: 'bad\ntext'}, menu: []}, /control/);
assertInvalid({version: 1, type: 'snapshot', panel: {text: '\ud800'}, menu: []}, /Unicode scalar/);
assertInvalid({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: [
        {id: 'same', kind: 'separator'},
        {id: 'same', kind: 'separator'},
    ],
}, /duplicated/);
assertInvalid({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: [{id: 'link', kind: 'link', text: 'Open', uri: 'http://example.com'}],
}, /HTTPS/);

print('ok - protocol snapshots and heartbeats are strictly validated');
