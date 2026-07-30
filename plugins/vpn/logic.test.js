// SPDX-License-Identifier: GPL-3.0-or-later

import {vpnSnapshot} from './logic.js';

if (vpnSnapshot({protected: false, country_code: 'NL'}).panel !== null)
    throw new Error('Unprotected VPN state is not hidden');
const protectedState = vpnSnapshot({
    protected: true,
    country_code: 'NL',
    country: 'Netherlands',
    city: 'Amsterdam',
    ip: '192.0.2.1',
});
if (protectedState.panel.text !== '☠︎' ||
    protectedState.menu[0].text !== 'Connected to NL' ||
    protectedState.menu[1].text !== 'Location: Amsterdam, Netherlands' ||
    JSON.stringify(protectedState).includes('192.0.2.1'))
    throw new Error('Protected VPN state is incorrect');
print('ok - VPN hides unprotected state and presents protected location privately');
