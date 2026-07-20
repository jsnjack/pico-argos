// SPDX-License-Identifier: GPL-3.0-or-later

import {weatherSnapshot} from './logic.js';

const snapshot = weatherSnapshot({
    current: {
        temperature_2m: 12.4,
        apparent_temperature: 10.6,
        precipitation: 0.4,
        weather_code: 61,
    },
    hourly: {
        time: ['2026-07-20T10:00', '2026-07-20T11:00', '2026-07-20T12:00'],
        temperature_2m: [12.4, 13, 14.2],
        rain: [0, 0.2, 1.4],
        uv_index: [3.2, 4, 4.5],
    },
}, 'Amsterdam');
if (snapshot.panel.text !== '12°C ▴' ||
    snapshot.panel.icon !== 'weather-showers-symbolic' ||
    snapshot.menu.find(item => item.id === 'two-hour')?.text !== 'In two hours 14°C' ||
    snapshot.menu.filter(item => item.id.startsWith('rain-')).length !== 3)
    throw new Error(`Weather snapshot is incomplete: ${JSON.stringify(snapshot)}`);
print('ok - weather plugin renders conditions, forecast, UV, and rain timeline');
