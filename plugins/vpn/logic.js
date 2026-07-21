// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts the public VPN status response into hidden/protected state. */
export function vpnSnapshot(status) {
    if (typeof status?.protected !== 'boolean')
        throw new Error('VPN response has no protected boolean');
    const countryCode = optionalText(status.country_code) ??
        optionalText(status.country) ?? 'Unknown';
    const countryName = optionalText(status.country);
    const city = optionalText(status.city);
    const location = [city, countryName]
        .filter((value, index, values) => value !== null &&
            value !== countryCode && values.indexOf(value) === index)
        .join(', ');
    const menu = [{
        id: 'country',
        kind: 'label',
        text: `Connected to ${countryCode}`,
    }];
    if (location.length !== 0)
        menu.push({id: 'location', kind: 'label', text: `Location: ${location}`});
    return {
        version: 1,
        type: 'snapshot',
        panel: status.protected
            ? {
                icon: 'weather-snow-symbolic',
                appearance: 'compact',
                accessibleName: `VPN protected in ${location || countryCode}`,
                severity: 'normal',
            }
            : null,
        menu,
    };
}

function optionalText(value) {
    if (value === undefined || value === null || value === '')
        return null;
    if (typeof value !== 'string' || [...value].length > 64 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        throw new Error('VPN response location is invalid');
    }
    return value;
}
