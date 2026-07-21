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
        temperature: {now: 12, end: 14},
        feels_like: {now: 11},
        uv_index: {now: 3},
        condition: 'partly_cloudy',
        location: {description: 'Amsterdam'},
        buienalarm: {data: [{time: '2026-07-20T10:00', value: 0}]},
    }),
];
for (const snapshot of snapshots) {
    const parsed = parseProtocolMessage(JSON.stringify(snapshot));
    if (parsed.kind !== 'snapshot')
        throw new Error('Reference plugin output did not parse as a snapshot');
}
print('ok - every reference plugin emits the strict public protocol');
