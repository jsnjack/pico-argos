// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_DEVICES_PER_CLASS = 28;

/** Converts bounded PipeWire device state into one protocol-v2 snapshot. */
export function audioSnapshot(state, config = {}) {
    const normalized = normalizeState(state, config);
    const output = normalized.outputs.find(device =>
        device.id === normalized.defaultOutputId) ?? null;
    const input = normalized.inputs.find(device =>
        device.id === normalized.defaultInputId) ?? null;
    const outputText = panelName(
        output?.shortLabel ?? 'No output',
        normalized.nameLimit);
    const inputText = panelName(
        input?.shortLabel ?? 'No mic',
        normalized.nameLimit);
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

    return {
        version: 2,
        type: 'snapshot',
        panel: {
            text: `${outputText} · ${inputText}`,
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
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4_096)
        throw new Error('Audio activation exceeds 4096 bytes');
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid audio activation JSON: ${error.message}`);
    }
    requireObject(value, 'Audio activation');
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
    return Object.freeze({id: value.id, requestId: value.requestId});
}

function normalizeState(state, config) {
    requireObject(state, 'Audio state');
    const parsedConfig = parseAudioConfig(config);
    const aliases = parsedConfig.aliases;
    return {
        outputs: normalizeDevices(state.outputs, aliases, 'output'),
        inputs: normalizeDevices(state.inputs, aliases, 'input'),
        defaultOutputId: normalizeDefault(state.defaultOutputId),
        defaultInputId: normalizeDefault(state.defaultInputId),
        nameLimit: parsedConfig.maxPanelNameChars,
    };
}

function normalizeDevices(values, aliases, context) {
    if (!Array.isArray(values))
        throw new Error(`Audio ${context} devices must be an array`);
    const seen = new Set();
    return values.slice(0, MAX_DEVICES_PER_CLASS).map((value, index) => {
        requireObject(value, `Audio ${context} device ${index}`);
        rejectUnknown(
            value,
            new Set(['id', 'nodeName', 'label', 'shortLabel']),
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
        if (seen.has(id))
            throw new Error(`Audio ${context} device ID is duplicated: ${id}`);
        seen.add(id);
        return {
            id,
            nodeName: value.nodeName,
            label: aliases[value.nodeName] ?? value.label.trim(),
            shortLabel: aliases[value.nodeName] ?? shortLabel.trim(),
        };
    }).sort((left, right) =>
        left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
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
