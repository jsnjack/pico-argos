// SPDX-License-Identifier: GPL-3.0-or-later

import {
    encodeActionRequest,
    MAX_MESSAGE_BYTES,
    parseProtocolMessage,
    ProtocolError,
} from './protocol.js';

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
assertInvalid({version: 1, type: 'heartbeat', extra: true}, /unknown/, {
    allowHeartbeat: true,
});
assertInvalid({version: 2, type: 'snapshot', panel: null, menu: []}, /version/);
const interactive = parseProtocolMessage(JSON.stringify({
    version: 2,
    type: 'snapshot',
    panel: {text: 'Speakers · Microphone'},
    menu: [
        {id: 'output:44', kind: 'action', text: 'Speakers', selected: true},
        {id: 'input:59', kind: 'action', text: 'Microphone', selected: false},
    ],
}), {protocolVersion: 2});
assertEqual(interactive.snapshot.menu[0], {
    id: 'output:44',
    kind: 'action',
    text: 'Speakers',
    selected: true,
}, 'interactive menu action');
assertInvalid({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: [{id: 'action', kind: 'action', text: 'Switch', selected: false}],
}, /version 2/);
assertInvalid({
    version: 2,
    type: 'snapshot',
    panel: null,
    menu: [{id: 'action', kind: 'action', text: 'Switch'}],
}, /selected/, {protocolVersion: 2});
assertInvalid({
    version: 2,
    type: 'snapshot',
    panel: null,
    menu: [{id: 'x'.repeat(129), kind: 'action', text: 'Switch', selected: false}],
}, /128/, {protocolVersion: 2});
assertEqual(parseProtocolMessage(JSON.stringify({
    version: 2,
    type: 'action-result',
    requestId: 7,
    ok: true,
}), {
    protocolVersion: 2,
    allowActionResult: true,
}), {
    kind: 'action-result',
    requestId: 7,
    ok: true,
    message: null,
}, 'action result');
assertInvalid({
    version: 2,
    type: 'action-result',
    requestId: 7,
    ok: true,
}, /execution mode/, {protocolVersion: 2});
assertInvalid({
    version: 2,
    type: 'action-result',
    requestId: 0,
    ok: false,
    message: 'failed',
}, /requestId/, {protocolVersion: 2, allowActionResult: true});
assertEqual(new TextDecoder().decode(encodeActionRequest('output:44', 7)),
    '{"version":2,"type":"activate","id":"output:44","requestId":7}\n',
    'encoded action request');
assertInvalid({version: 1, type: 'snapshot', panel: null, menu: [], typo: true}, /unknown/);
assertInvalid({version: 1, type: 'snapshot', panel: {visible: true}, menu: []}, /text or icon/);
assertInvalid({version: 1, type: 'snapshot', panel: {icon: 'test-symbolic'}, menu: []}, /accessible/);
assertInvalid({version: 1, type: 'snapshot', panel: {text: 'bad\ntext'}, menu: []}, /control/);
assertInvalid({version: 1, type: 'snapshot', panel: {text: '\ud800'}, menu: []}, /Unicode scalar/);
assertInvalid({
    version: 1,
    type: 'snapshot',
    panel: {text: 'x'.repeat(129)},
    menu: [],
}, /128/);
const maximumPanel = parseProtocolMessage(JSON.stringify({
    version: 1,
    type: 'snapshot',
    panel: {text: '💡'.repeat(128)},
    menu: [],
}));
assertEqual([...maximumPanel.snapshot.panel.text].length, 128, 'panel scalar limit');
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
assertInvalid({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: Array.from({length: 65}, (_value, index) => ({
        id: `item-${index}`,
        kind: 'separator',
    })),
}, /64 entries/);
const maximumMenu = parseProtocolMessage(JSON.stringify({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: Array.from({length: 64}, (_value, index) => ({
        id: `item-${index}`,
        kind: 'label',
        text: 'x'.repeat(512),
    })),
}));
assertEqual(maximumMenu.snapshot.menu.length, 64, 'menu entry limit');
assertInvalid({
    version: 1,
    type: 'snapshot',
    panel: null,
    menu: [{id: 'empty', kind: 'label', text: ''}],
}, /empty/);
try {
    parseProtocolMessage(' '.repeat(MAX_MESSAGE_BYTES + 1));
    throw new Error('Oversized protocol input unexpectedly parsed');
} catch (error) {
    if (!(error instanceof ProtocolError) || !/exceeds/.test(error.message))
        throw error;
}

print('ok - protocol snapshots and heartbeats are strictly validated');
