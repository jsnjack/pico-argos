// SPDX-License-Identifier: GPL-3.0-or-later

import {parseProtocolMessage} from '../pico-argos@jsnjack.github.io/lib/protocol.js';
import {dependabotSnapshot} from './dependabot/logic.js';
import {pullReviewsSnapshot} from './pull-reviews/logic.js';
import {systemSnapshot} from './system-monitor/metrics.js';
import {vpnSnapshot} from './vpn/logic.js';
import {weatherSnapshot} from './weather/logic.js';

const snapshots = [
    dependabotSnapshot([
        {state: 'open', security_advisory: {severity: 'critical'}},
    ], 'example/project'),
    pullReviewsSnapshot({issueCount: 2}, 'octocat', ['example/project']),
    systemSnapshot({cpu: 10, memory: 20, disk: 30, receive: 1_000, transmit: 2_000}),
    vpnSnapshot({protected: true, country_code: 'NL'}),
    weatherSnapshot({
        current: {
            temperature_2m: 12,
            apparent_temperature: 11,
            precipitation: 0,
            weather_code: 1,
        },
        hourly: {
            time: ['2026-07-20T10:00', '2026-07-20T11:00', '2026-07-20T12:00'],
            temperature_2m: [12, 13, 14],
            rain: [0, 0, 0],
            uv_index: [3, 4, 5],
        },
    }, 'Amsterdam'),
];
for (const snapshot of snapshots) {
    const parsed = parseProtocolMessage(JSON.stringify(snapshot));
    if (parsed.kind !== 'snapshot')
        throw new Error('Reference plugin output did not parse as a snapshot');
}
print('ok - every reference plugin emits the strict public protocol');
