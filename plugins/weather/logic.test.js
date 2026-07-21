// SPDX-License-Identifier: GPL-3.0-or-later

import {weatherSnapshot} from './logic.js';

const snapshot = weatherSnapshot({
    temperature: {now: 12.4, end: 14.2},
    feels_like: {now: 10.6},
    uv_index: {now: 3.2},
    condition: 'rain',
    location: {description: 'Amsterdam'},
    buienalarm: {
        desc: 'Showers passing through',
        data: [
            {time: '2026-07-20T10:00:00+02:00', value: 0},
            {time: '2026-07-20T11:00:00+02:00', value: 0.2},
            {time: '2026-07-20T12:00:00+02:00', value: 1.4},
        ],
    },
});
if (snapshot.panel.text !== '12.4° ···' ||
    snapshot.panel.icon !== 'weather-showers-symbolic' ||
    snapshot.menu.find(item => item.id === 'two-hour')?.text !== '  In 2 hours    14.2°' ||
    snapshot.menu.find(item => item.id === 'rain-description')?.text !== '  Showers passing through' ||
    snapshot.menu.filter(item => /^rain-\d+$/.test(item.id)).length !== 2)
    throw new Error(`Weather snapshot is incomplete: ${JSON.stringify(snapshot)}`);

const dry = weatherSnapshot({
    temperature: {now: 8, end: 9},
    feels_like: {now: 7},
    uv_index: {now: 0},
    condition: 'unknown',
    location: {description: 'Home'},
    buienalarm: {data: [{time: '2026-07-20T10:00', value: 0.05}]},
});
if (dry.panel.text !== '8°' || dry.panel.icon !== 'weather-clear-symbolic' ||
    dry.menu.some(item => item.id === 'rain-heading'))
    throw new Error('Dry weather state does not preserve the legacy all-clear presentation');
print('ok - weather preserves yauhen.cc conditions, details, and rain timeline');
