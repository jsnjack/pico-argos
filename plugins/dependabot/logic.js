// SPDX-License-Identifier: GPL-3.0-or-later

/** Converts one GitHub Dependabot alert page into protocol state. */
export function dependabotSnapshot(alerts, repository) {
    if (!Array.isArray(alerts))
        throw new Error('GitHub Dependabot response must be an array');
    const critical = alerts.filter(alert =>
        alert?.state === 'open' &&
        alert?.security_advisory?.severity === 'critical');
    const count = critical.length;
    const uri = `https://github.com/${repository}/security/dependabot` +
        '?q=is%3Aopen+severity%3Acritical';
    const menu = [];
    if (count !== 0) {
        menu.push({
            id: 'summary',
            kind: 'label',
            text: `${count} critical ${count === 1 ? 'vulnerability' : 'vulnerabilities'} ` +
                `in ${repository}`,
        });
        const ids = new Set();
        for (const [index, alert] of critical.entries()) {
            if (menu.length === 6)
                break;
            const alertUri = alert?.html_url;
            if (typeof alertUri !== 'string' ||
                !alertUri.startsWith('https://github.com/'))
                continue;
            const number = Number.isInteger(alert?.number) && alert.number >= 0
                ? alert.number
                : index;
            const id = `alert-${number}`;
            if (ids.has(id))
                continue;
            ids.add(id);
            menu.push({
                id,
                kind: 'link',
                text: alertText(alert, index),
                uri: alertUri,
            });
        }
        if (menu.length > 1)
            menu.push({id: 'alerts-separator', kind: 'separator'});
    }
    menu.push({
        id: 'alerts',
        kind: 'link',
        text: count === 0
            ? 'View critical vulnerabilities'
            : 'View all critical vulnerabilities',
        uri,
    });
    return {
        version: 1,
        type: 'snapshot',
        panel: count === 0
            ? null
            : {
                text: String(count),
                icon: 'software-update-urgent-symbolic',
                appearance: 'compact',
                accessibleName: `${count} critical dependency ${count === 1 ? 'alert' : 'alerts'}`,
                severity: 'critical',
            },
        menu,
    };
}

function alertText(alert, index) {
    const packageName = cleanText(alert?.dependency?.package?.name, `Dependency ${index + 1}`);
    const summary = cleanText(alert?.security_advisory?.summary, 'Critical advisory');
    return truncate(`${packageName} — ${summary}`, 160);
}

function cleanText(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
    return cleaned.length === 0 ? fallback : cleaned;
}

function truncate(value, maximumScalars) {
    const scalars = [...value];
    return scalars.length <= maximumScalars
        ? value
        : `${scalars.slice(0, maximumScalars - 1).join('')}…`;
}
