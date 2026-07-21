// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one GitHub Dependabot alert page into protocol state. */
export function dependabotSnapshot(alerts, repository) {
    if (!Array.isArray(alerts))
        throw new Error('GitHub Dependabot response must be an array');
    const count = alerts.filter(alert =>
        alert?.state === 'open' &&
        alert?.security_advisory?.severity === 'critical').length;
    const uri = `https://github.com/${repository}/security/dependabot` +
        '?q=is%3Aopen+severity%3Acritical';
    return {
        version: 1,
        type: 'snapshot',
        panel: count === 0
            ? null
            : {
                text: `${count} 🤖`,
                appearance: 'compact',
                accessibleName: `${count} critical dependency ${count === 1 ? 'alert' : 'alerts'}`,
                severity: 'critical',
            },
        menu: [{
            id: 'alerts',
            kind: 'link',
            text: 'View Vulnerabilities',
            uri,
        }],
    };
}
