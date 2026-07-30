// SPDX-License-Identifier: GPL-3.0-or-later

import {
    audioSnapshot,
    MAX_DEVICES_PER_CLASS,
    parseActivation,
    parseAudioConfig,
} from './logic.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertInvalid(callback, pattern) {
    try {
        callback();
    } catch (error) {
        if (!pattern.test(error.message))
            throw new Error(`Unexpected error: ${error.message}`);
        return;
    }
    throw new Error('Expected invalid audio value');
}

const state = {
    outputs: [
        {id: 45, nodeName: 'bluez.output', label: 'LinkBuds Fit'},
        {
            id: 44,
            nodeName: 'alsa.output',
            label: 'Built-in Audio Analog Stereo',
            shortLabel: 'Speakers',
        },
    ],
    inputs: [
        {
            id: 59,
            nodeName: 'alsa.input',
            label: 'Built-in Audio Microphone',
            shortLabel: 'Microphone',
        },
    ],
    defaultOutputId: 45,
    defaultInputId: 59,
};
const snapshot = audioSnapshot(state, {
    maxPanelNameChars: 12,
    aliases: {'alsa.input': 'Laptop mic'},
});
assertEqual(snapshot.panel.text, 'LinkBuds Fit', 'current audio panel');
assertEqual(snapshot.menu.filter(item => item.kind === 'action'), [
    {id: 'output:44', kind: 'action', text: 'Built-in Audio Analog Stereo', selected: false},
    {id: 'output:45', kind: 'action', text: 'LinkBuds Fit', selected: true},
    {id: 'input:59', kind: 'action', text: 'Laptop mic', selected: true},
], 'device action rows');

const absent = audioSnapshot({
    outputs: [],
    inputs: [],
    defaultOutputId: null,
    defaultInputId: null,
});
assertEqual(absent.panel.text, 'No output · No mic', 'absent devices panel');
if (!absent.menu.some(item => item.id === 'output-empty') ||
    !absent.menu.some(item => item.id === 'input-empty'))
    throw new Error('Absent device state omitted explanatory menu rows');

const long = audioSnapshot({
    outputs: [
        {id: 1, nodeName: 'output', label: 'A very long speaker name'},
        {id: 3, nodeName: 'other-output', label: 'Zither'},
    ],
    inputs: [
        {id: 2, nodeName: 'input', label: 'A very long microphone name'},
        {id: 4, nodeName: 'other-input', label: 'Zither mic'},
    ],
    defaultOutputId: 1,
    defaultInputId: 2,
}, {maxPanelNameChars: 8});
assertEqual(long.panel.text, 'A very … · A very …', 'bounded panel names');

const single = audioSnapshot({
    outputs: [{id: 1, nodeName: 'output', label: 'Speakers'}],
    inputs: [{id: 2, nodeName: 'input', label: 'Microphone'}],
    defaultOutputId: 1,
    defaultInputId: 2,
});
assertEqual(single.panel.text, null, 'unambiguous panel is icon-only');
assertEqual(
    single.panel.accessibleName,
    'Audio output Speakers; microphone Microphone',
    'icon-only panel keeps an accessible name');

const mixed = audioSnapshot({
    outputs: [
        {id: 1, nodeName: 'output', label: 'Speakers'},
        {id: 3, nodeName: 'other-output', label: 'Headset'},
    ],
    inputs: [{id: 2, nodeName: 'input', label: 'Microphone'}],
    defaultOutputId: 1,
    defaultInputId: 2,
});
assertEqual(mixed.panel.text, 'Speakers', 'only the ambiguous class is named');

const ports = audioSnapshot({
    outputs: [
        {
            id: 1,
            nodeName: 'alsa.analog',
            label: 'Built-in Audio Analog Stereo',
            portLabel: 'Line Out',
            portChoices: 2,
        },
        {
            id: 3,
            nodeName: 'alsa.hdmi',
            label: 'DELL U2719D',
            portLabel: 'HDMI / DisplayPort',
            portChoices: 1,
        },
    ],
    inputs: [],
    defaultOutputId: 1,
    defaultInputId: null,
});
assertEqual(ports.menu.filter(item => item.kind === 'action'), [
    {id: 'output:3', kind: 'action', text: 'DELL U2719D', selected: false},
    {id: 'output:1', kind: 'action', text: 'Line Out', selected: true},
], 'cards with a port choice are named by their active port');
assertInvalid(() => audioSnapshot({
    outputs: [{id: 1, nodeName: 'output', label: 'Speakers', portChoices: -1}],
    inputs: [],
    defaultOutputId: null,
    defaultInputId: null,
}), /port choices/);

const many = Array.from({length: 40}, (_value, index) => ({
    id: index,
    nodeName: `output-${index}`,
    label: `Output ${index}`,
}));
const bounded = audioSnapshot({
    outputs: many,
    inputs: many.map(device => ({
        ...device,
        id: device.id + 100,
        nodeName: `input-${device.id}`,
    })),
    defaultOutputId: null,
    defaultInputId: null,
});
assertEqual(
    bounded.menu.filter(item => item.kind === 'action').length,
    MAX_DEVICES_PER_CLASS * 2,
    'bounded device menus');
if (bounded.menu.length > 64)
    throw new Error(`Audio menu exceeded protocol limit: ${bounded.menu.length}`);

assertEqual(parseActivation(
    '{"version":2,"type":"activate","id":"output:44","requestId":7}'),
{id: 'output:44', requestId: 7}, 'activation input');
assertInvalid(() => parseActivation(
    '{"version":2,"type":"activate","id":"output:44","requestId":0}'),
/requestId/);
assertInvalid(() => parseActivation(
    '{"version":2,"type":"activate","id":"output:44","requestId":7,"shell":"bad"}'),
/unknown/);
assertInvalid(() => parseAudioConfig({maxPanelNameChars: 5}), /6 through 48/);
assertInvalid(() => audioSnapshot({
    ...state,
    outputs: [...state.outputs, state.outputs[0]],
}), /duplicated/);

print('ok - audio device state and activation input are strictly bounded');
