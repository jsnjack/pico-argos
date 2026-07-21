// SPDX-License-Identifier: GPL-3.0-or-later

import {dependabotSnapshot} from './logic.js';

const repository = 'example/project';
const hidden = dependabotSnapshot([], repository);
if (hidden.panel !== null || hidden.menu.length !== 1)
    throw new Error('Dependabot zero state is not hidden with its cached link');
const visible = dependabotSnapshot([
    {
        number: 7,
        state: 'open',
        dependency: {package: {name: 'example-package'}},
        security_advisory: {severity: 'critical', summary: 'Remote code execution'},
        html_url: 'https://github.com/example/project/security/dependabot/7',
    },
    {state: 'dismissed', security_advisory: {severity: 'critical'}},
    {state: 'open', security_advisory: {severity: 'high'}},
], repository);
if (visible.panel.text !== '1' ||
    visible.panel.icon !== 'software-update-urgent-symbolic' ||
    visible.panel.severity !== 'critical' ||
    visible.menu.find(item => item.id === 'alert-7')?.text !==
        'example-package — Remote code execution' ||
    !visible.menu.find(item => item.id === 'alerts')?.uri
        .startsWith('https://github.com/example/project/'))
    throw new Error('Dependabot critical state is incorrect');
print('ok - Dependabot hides zero and presents bounded critical alert links');
