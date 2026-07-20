// SPDX-License-Identifier: GPL-3.0-or-later

import {vpnSnapshot} from './logic.js';

if (vpnSnapshot({protected: false, country_code: 'NL'}).panel !== null)
    throw new Error('Unprotected VPN state is not hidden');
const protectedState = vpnSnapshot({protected: true, country_code: 'NL'});
if (protectedState.panel.icon !== 'network-vpn-symbolic' ||
    protectedState.menu[0].text !== 'Protected country: NL')
    throw new Error('Protected VPN state is incorrect');
print('ok - VPN plugin hides unprotected state and shows protected country');
