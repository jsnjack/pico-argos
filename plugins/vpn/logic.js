// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts the public VPN status response into hidden/protected state. */
export function vpnSnapshot(status) {
    if (typeof status?.protected !== 'boolean')
        throw new Error('VPN response has no protected boolean');
    const country = status.country_code ?? status.country ?? 'Unknown';
    if (typeof country !== 'string' || country.length === 0 || country.length > 64)
        throw new Error('VPN response country is invalid');
    return {
        version: 1,
        type: 'snapshot',
        panel: status.protected
            ? {
                icon: 'weather-snow-symbolic',
                appearance: 'compact',
                accessibleName: `VPN protected in ${country}`,
                severity: 'normal',
            }
            : null,
        menu: [{id: 'country', kind: 'label', text: `Connected to ${country}`}],
    };
}
