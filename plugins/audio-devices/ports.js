// SPDX-License-Identifier: GPL-3.0-or-later

/** Collapses one `pw-dump` document to bounded audio-card route metadata. */
export function parsePorts(objects) {
    const ports = new Map();
    if (!Array.isArray(objects))
        throw new Error('pw-dump output is not an array');
    for (const object of objects) {
        if (object?.type !== 'PipeWire:Interface:Device')
            continue;
        const params = object.info?.params;
        if (params === null || typeof params !== 'object')
            continue;
        for (const route of asArray(params.Route)) {
            if (!Number.isInteger(route?.device) ||
                typeof route.direction !== 'string' ||
                typeof route.description !== 'string')
                continue;
            const key = portKey(object.id, route.device, route.direction);
            ports.set(key, {
                description: route.description,
                choices: ports.get(key)?.choices ?? 0,
                availability: mergeAvailability(
                    ports.get(key)?.availability,
                    route.available),
            });
        }
        for (const route of asArray(params.EnumRoute)) {
            if (!Array.isArray(route?.devices) ||
                typeof route.direction !== 'string')
                continue;
            for (const device of route.devices) {
                if (!Number.isInteger(device))
                    continue;
                const key = portKey(object.id, device, route.direction);
                const entry = ports.get(key);
                if (entry === undefined) {
                    ports.set(key, {
                        description: null,
                        choices: 1,
                        availability: mergeAvailability(
                            undefined,
                            route.available),
                    });
                } else {
                    entry.choices++;
                    entry.availability = mergeAvailability(
                        entry.availability,
                        route.available);
                }
            }
        }
    }
    return ports;
}

/** Returns the stable lookup key for one card profile device and direction. */
export function portKey(deviceId, cardDevice, direction) {
    return `${deviceId}:${cardDevice}:${direction}`;
}

function mergeAvailability(current, value) {
    const next = value === 'yes' || value === 'no' ? value : 'unknown';
    if (current === undefined)
        return next;
    if (current === 'yes' || next === 'yes')
        return 'yes';
    if (current === 'unknown' || next === 'unknown')
        return 'unknown';
    return 'no';
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}
