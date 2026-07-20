// SPDX-License-Identifier: GPL-3.0-or-later

import {dependabotSnapshot} from './logic.js';

const repository = 'example/project';
const hidden = dependabotSnapshot([], repository);
if (hidden.panel !== null || hidden.menu.length !== 1)
    throw new Error('Dependabot zero state is not hidden with its cached link');
const visible = dependabotSnapshot([
    {state: 'open', security_advisory: {severity: 'critical'}},
    {state: 'dismissed', security_advisory: {severity: 'critical'}},
    {state: 'open', security_advisory: {severity: 'high'}},
], repository);
if (visible.panel.text !== '1' || visible.panel.severity !== 'critical' ||
    !visible.menu[0].uri.startsWith('https://github.com/example/project/'))
    throw new Error('Dependabot critical state is incorrect');
print('ok - Dependabot plugin hides zero and links critical alerts');
