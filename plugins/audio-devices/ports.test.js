// SPDX-License-Identifier: GPL-3.0-or-later

import {isDevicePortVisible, parsePorts, portKey} from './ports.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const splitCard = parsePorts([{
    id: 43,
    type: 'PipeWire:Interface:Device',
    info: {
        params: {
            Route: [
                {
                    device: 0,
                    direction: 'Output',
                    description: 'Speaker',
                    available: 'unknown',
                },
                {
                    device: 2,
                    direction: 'Input',
                    description: 'SoundWire microphones',
                    available: 'unknown',
                },
            ],
            EnumRoute: [
                {devices: [0], direction: 'Output', available: 'unknown'},
                {devices: [1], direction: 'Output', available: 'no'},
                {devices: [2], direction: 'Input', available: 'unknown'},
                {devices: [3], direction: 'Input', available: 'no'},
            ],
        },
    },
}]);

assertEqual(splitCard.get(portKey(43, 0, 'Output')), {
    description: 'Speaker',
    choices: 1,
    availability: 'unknown',
}, 'built-in speaker remains available');
assertEqual(splitCard.get(portKey(43, 1, 'Output')), {
    description: null,
    choices: 1,
    availability: 'no',
}, 'disconnected headphones are unavailable');
assertEqual(splitCard.get(portKey(43, 3, 'Input')), {
    description: null,
    choices: 1,
    availability: 'no',
}, 'disconnected headset microphone is unavailable');

const sharedNode = parsePorts([{
    id: 7,
    type: 'PipeWire:Interface:Device',
    info: {
        params: {
            EnumRoute: [
                {devices: [0], direction: 'Output', available: 'unknown'},
                {devices: [0], direction: 'Output', available: 'no'},
            ],
        },
    },
}]).get(portKey(7, 0, 'Output'));
assertEqual(sharedNode, {
    description: null,
    choices: 2,
    availability: 'unknown',
}, 'one unavailable connector does not hide a shared node');

assertEqual(
    isDevicePortVisible({availability: 'no'}, 57, '57'),
    true,
    'effective default remains visible when availability is stale');
assertEqual(
    isDevicePortVisible({availability: 'no'}, 56, '57'),
    false,
    'unavailable non-default remains hidden');
assertEqual(
    isDevicePortVisible(null, 56, '57'),
    true,
    'device without port metadata remains visible');

print('ok - audio route availability is parsed and combined');
