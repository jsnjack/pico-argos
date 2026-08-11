// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_DEVICES_PER_CLASS = 28;
export const MAX_ACTIVE_ROUTES = 3;

/** Converts bounded PipeWire device state into one protocol-v2 snapshot. */
export function audioSnapshot(state, config = {}) {
    const normalized = normalizeState(state, config);
    const output = normalized.outputs.find(device =>
        device.id === normalized.defaultOutputId) ?? null;
    const input = normalized.inputs.find(device =>
        device.id === normalized.defaultInputId) ?? null;
    // A class with exactly one device offers no choice, so its name only costs
    // panel width; drop it and let the icon carry the plugin's identity.
    const parts = [];
    if (normalized.outputs.length !== 1) {
        parts.push(panelName(
            output?.shortLabel ?? 'No output',
            normalized.nameLimit));
    }
    if (normalized.inputs.length !== 1) {
        parts.push(panelName(
            input?.shortLabel ?? 'No mic',
            normalized.nameLimit));
    }
    const menu = [
        label('output-heading', 'Output'),
        ...deviceActions('output', normalized.outputs, output?.id ?? null),
    ];
    if (normalized.outputs.length === 0)
        menu.push(label('output-empty', 'No output devices'));
    menu.push({id: 'audio-separator', kind: 'separator'});
    menu.push(label('input-heading', 'Microphone'));
    menu.push(...deviceActions('input', normalized.inputs, input?.id ?? null));
    if (normalized.inputs.length === 0)
        menu.push(label('input-empty', 'No microphones'));
    if (normalized.routes.length !== 0) {
        menu.push({id: 'route-separator', kind: 'separator'});
        menu.push(label('route-heading', 'Active applications'));
        menu.push(...routeLabels(normalized));
    }

    return {
        version: 2,
        type: 'snapshot',
        panel: {
            text: parts.length === 0 ? null : parts.join(' · '),
            icon: 'audio-speakers-symbolic',
            appearance: 'compact',
            accessibleName: `Audio output ${output?.label ?? 'unavailable'}; ` +
                `microphone ${input?.label ?? 'unavailable'}`,
            severity: 'normal',
        },
        menu,
    };
}

/** Strictly validates the optional user configuration. */
export function parseAudioConfig(value) {
    if (value === undefined)
        return Object.freeze({maxPanelNameChars: 18, aliases: Object.freeze({})});
    requireObject(value, 'Audio configuration');
    rejectUnknown(value, new Set(['maxPanelNameChars', 'aliases']), 'Audio configuration');
    const maxPanelNameChars = value.maxPanelNameChars ?? 18;
    if (!Number.isInteger(maxPanelNameChars) ||
        maxPanelNameChars < 6 ||
        maxPanelNameChars > 48)
        throw new Error('Audio maxPanelNameChars must be from 6 through 48');
    const aliases = value.aliases ?? {};
    requireObject(aliases, 'Audio aliases');
    if (Object.keys(aliases).length > 64)
        throw new Error('Audio aliases exceed 64 entries');
    const normalizedAliases = {};
    for (const [nodeName, alias] of Object.entries(aliases)) {
        requireText(nodeName, 256, 'Audio alias node name');
        requireText(alias, 64, `Audio alias for ${nodeName}`);
        normalizedAliases[nodeName] = alias.trim();
    }
    return Object.freeze({
        maxPanelNameChars,
        aliases: Object.freeze(normalizedAliases),
    });
}

/** Strictly parses one core-to-plugin activation line. */
export function parseActivation(raw) {
    const request = parseAudioRequest(raw);
    if (request.type !== 'activate')
        throw new Error('Audio request is not an activation');
    return Object.freeze({id: request.id, requestId: request.requestId});
}

/** Strictly parses one core-to-plugin protocol-v2 input line. */
export function parseAudioRequest(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4_096)
        throw new Error('Audio request exceeds 4096 bytes');
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid audio request JSON: ${error.message}`);
    }
    requireObject(value, 'Audio request');
    if (value.type === 'menu-open') {
        rejectUnknown(value, new Set(['version', 'type']), 'Audio menu-open request');
        if (value.version !== 2)
            throw new Error('Audio menu-open request version is invalid');
        return Object.freeze({type: 'menu-open'});
    }
    rejectUnknown(
        value,
        new Set(['version', 'type', 'id', 'requestId']),
        'Audio activation');
    if (value.version !== 2 || value.type !== 'activate')
        throw new Error('Audio activation version or type is invalid');
    requireText(value.id, 128, 'Audio activation ID');
    if (!Number.isInteger(value.requestId) ||
        value.requestId < 1 ||
        value.requestId > 2_147_483_647)
        throw new Error('Audio activation requestId is invalid');
    return Object.freeze({type: 'activate', id: value.id, requestId: value.requestId});
}

function normalizeState(state, config) {
    requireObject(state, 'Audio state');
    const parsedConfig = parseAudioConfig(config);
    const aliases = parsedConfig.aliases;
    const outputs = normalizeDevices(state.outputs, aliases, 'output');
    const inputs = normalizeDevices(state.inputs, aliases, 'input');
    const defaultOutputId = normalizeDefault(state.defaultOutputId);
    const defaultInputId = normalizeDefault(state.defaultInputId);
    return {
        outputs,
        inputs,
        defaultOutputId,
        defaultInputId,
        routes: normalizeRoutes(state.routes ?? [], outputs, inputs),
        nameLimit: parsedConfig.maxPanelNameChars,
    };
}

function normalizeRoutes(values, outputs, inputs) {
    if (!Array.isArray(values))
        throw new Error('Audio application routes must be an array');
    const devices = {
        output: new Map(outputs.map(device => [device.id, device])),
        input: new Map(inputs.map(device => [device.id, device])),
    };
    const seen = new Set();
    const routes = [];
    for (const [index, value] of values.entries()) {
        requireObject(value, `Audio application route ${index}`);
        rejectUnknown(
            value,
            new Set(['streamId', 'direction', 'application', 'deviceId']),
            `Audio application route ${index}`);
        const streamId = String(value.streamId);
        const deviceId = String(value.deviceId);
        requireText(streamId, 96, `Audio application route ${index} stream ID`);
        requireText(deviceId, 96, `Audio application route ${index} device ID`);
        requireText(value.application, 128, `Audio application route ${index} application`);
        if (value.direction !== 'output' && value.direction !== 'input')
            throw new Error(`Audio application route ${index} direction is invalid`);
        const device = devices[value.direction].get(deviceId);
        if (device === undefined)
            continue;
        const key = `${value.direction}:${streamId}:${deviceId}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        routes.push({
            streamId,
            deviceId,
            direction: value.direction,
            application: value.application.trim(),
            device: device.label,
        });
    }
    return routes.sort((left, right) =>
        left.application.localeCompare(right.application) ||
        left.direction.localeCompare(right.direction) ||
        left.streamId.localeCompare(right.streamId) ||
        left.deviceId.localeCompare(right.deviceId))
        .slice(0, MAX_ACTIVE_ROUTES);
}

function normalizeDevices(values, aliases, context) {
    if (!Array.isArray(values))
        throw new Error(`Audio ${context} devices must be an array`);
    const seen = new Set();
    return values.slice(0, MAX_DEVICES_PER_CLASS).map((value, index) => {
        requireObject(value, `Audio ${context} device ${index}`);
        rejectUnknown(
            value,
            new Set([
                'id',
                'nodeName',
                'label',
                'shortLabel',
                'portLabel',
                'portChoices',
            ]),
            `Audio ${context} device ${index}`);
        const id = String(value.id);
        requireText(id, 96, `Audio ${context} device ${index} ID`);
        requireText(value.nodeName, 256, `Audio ${context} device ${index} node name`);
        requireText(value.label, 128, `Audio ${context} device ${index} label`);
        const shortLabel = value.shortLabel ?? value.label;
        requireText(
            shortLabel,
            128,
            `Audio ${context} device ${index} short label`);
        const portLabel = portName(value, `Audio ${context} device ${index}`);
        if (seen.has(id))
            throw new Error(`Audio ${context} device ID is duplicated: ${id}`);
        seen.add(id);
        const name = aliases[value.nodeName] ?? portLabel;
        return {
            id,
            nodeName: value.nodeName,
            label: name ?? value.label.trim(),
            shortLabel: name ?? shortLabel.trim(),
        };
    }).sort((left, right) =>
        left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

/**
 * Returns the active port description when the card actually offers a choice
 * of ports for this node, and null otherwise.
 *
 * A card exposing several ports for one node is named by the connector the
 * sound leaves through ("Line Out", "Headphones"). A card exposing exactly one
 * keeps its device name, which is the more specific identity there — an HDMI
 * card reports the connected monitor, while its single port is only ever
 * called "HDMI / DisplayPort".
 */
function portName(value, context) {
    const portLabel = value.portLabel ?? null;
    if (portLabel !== null)
        requireText(portLabel, 128, `${context} port label`);
    const portChoices = value.portChoices ?? 0;
    if (!Number.isInteger(portChoices) || portChoices < 0 || portChoices > 64)
        throw new Error(`${context} port choices is invalid`);
    return portChoices > 1 && portLabel !== null ? portLabel.trim() : null;
}

function normalizeDefault(value) {
    if (value === null || value === undefined)
        return null;
    const id = String(value);
    requireText(id, 96, 'Audio default device ID');
    return id;
}

function deviceActions(prefix, devices, selectedId) {
    return devices.map(device => ({
        id: `${prefix}:${device.id}`,
        kind: 'action',
        text: device.label,
        selected: device.id === selectedId,
    }));
}

function routeLabels(state) {
    return state.routes.map(route => {
        const defaultId = route.direction === 'output' ?
            state.defaultOutputId : state.defaultInputId;
        const mismatch = defaultId !== null && route.deviceId !== defaultId ?
            ' (not default)' : '';
        const routeText = route.direction === 'output' ?
            `playback → ${route.device}` : `microphone ← ${route.device}`;
        return label(
            `route:${route.direction}:${route.streamId}:${route.deviceId}`,
            `${route.application} — ${routeText}${mismatch}`);
    });
}

function panelName(value, maximum) {
    const compact = value
        .replace(/\bmicrophones?\b/giu, 'Mic')
        .replace(/\s+/gu, ' ')
        .trim();
    const scalars = [...compact];
    if (scalars.length <= maximum)
        return compact;
    return `${scalars.slice(0, maximum - 1).join('')}…`;
}

function label(id, text) {
    return {id, kind: 'label', text};
}

function requireObject(value, context) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${context} must be an object`);
}

function rejectUnknown(value, allowed, context) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error(`${context} contains unknown field: ${key}`);
    }
}

function requireText(value, maximum, context) {
    if (typeof value !== 'string' ||
        value.trim().length === 0 ||
        [...value].length > maximum ||
        /[\u0000-\u001f\u007f-\u009f]/.test(value))
        throw new Error(`${context} is invalid`);
}
