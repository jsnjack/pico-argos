// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

/** Protocol version accepted by this extension release. */
export const PROTOCOL_VERSION = 1;

/** Maximum encoded size of one protocol message. */
export const MAX_MESSAGE_BYTES = 64 * 1_024;

const TOP_LEVEL_KEYS = new Set(['version', 'type', 'panel', 'menu']);
const HEARTBEAT_KEYS = new Set(['version', 'type']);
const PANEL_KEYS = new Set([
    'visible',
    'text',
    'icon',
    'appearance',
    'accessibleName',
    'severity',
]);
const MENU_COMMON_KEYS = new Set(['id', 'kind']);
const MENU_TEXT_KEYS = new Set(['id', 'kind', 'text']);
const MENU_LINK_KEYS = new Set(['id', 'kind', 'text', 'uri']);
const ICON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPEARANCES = new Set(['compact', 'monospace', 'normal']);
const SEVERITIES = new Set(['normal', 'warning', 'critical']);

/** Describes invalid JSON or a version 1 protocol schema violation. */
export class ProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProtocolError';
        this.kind = 'protocol';
    }
}

/** Parses and validates one bounded snapshot or heartbeat message. */
export function parseProtocolMessage(raw, options = {}) {
    if (typeof raw !== 'string')
        throw new ProtocolError('Protocol message must be decoded UTF-8 text');
    if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES)
        throw new ProtocolError(`Protocol message exceeds ${MAX_MESSAGE_BYTES} bytes`);

    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new ProtocolError(`Invalid protocol JSON: ${error.message}`);
    }
    requirePlainObject(value, 'Protocol message');
    requireExact(value.version, PROTOCOL_VERSION, 'Protocol version');

    if (value.type === 'heartbeat') {
        if (!options.allowHeartbeat)
            throw new ProtocolError('Heartbeat is not valid in this execution mode');
        rejectUnknownKeys(value, HEARTBEAT_KEYS, 'Heartbeat');
        return Object.freeze({kind: 'heartbeat'});
    }
    if (value.type !== 'snapshot')
        throw new ProtocolError('Protocol type must be snapshot or heartbeat');

    rejectUnknownKeys(value, TOP_LEVEL_KEYS, 'Snapshot');
    if (!Object.hasOwn(value, 'panel'))
        throw new ProtocolError('Snapshot panel is required');
    if (!Array.isArray(value.menu))
        throw new ProtocolError('Snapshot menu must be an array');
    if (value.menu.length > 64)
        throw new ProtocolError('Snapshot menu exceeds 64 entries');

    const snapshot = {
        panel: validatePanel(value.panel),
        menu: validateMenu(value.menu),
    };
    freezeSnapshot(snapshot);
    return Object.freeze({kind: 'snapshot', snapshot});
}

function validatePanel(value) {
    if (value === null)
        return null;

    requirePlainObject(value, 'Panel');
    rejectUnknownKeys(value, PANEL_KEYS, 'Panel');
    const visible = value.visible ?? true;
    requireBoolean(visible, 'Panel visible');

    const text = value.text ?? null;
    if (text !== null)
        validateText(text, 128, 'Panel text');

    const icon = value.icon ?? null;
    if (icon !== null && (typeof icon !== 'string' || !ICON_PATTERN.test(icon)))
        throw new ProtocolError('Panel icon is not a valid icon-theme name');

    const appearance = value.appearance ?? 'normal';
    if (!APPEARANCES.has(appearance))
        throw new ProtocolError('Panel appearance is invalid');
    const severity = value.severity ?? 'normal';
    if (!SEVERITIES.has(severity))
        throw new ProtocolError('Panel severity is invalid');

    const accessibleName = value.accessibleName ?? null;
    if (accessibleName !== null)
        validateText(accessibleName, 512, 'Panel accessible name');

    if (visible && text === null && icon === null)
        throw new ProtocolError('Visible panel requires text or icon');
    if (visible && text === null && accessibleName === null)
        throw new ProtocolError('Icon-only panel requires an accessible name');

    return {visible, text, icon, appearance, accessibleName, severity};
}

function validateMenu(values) {
    const ids = new Set();
    return values.map((value, index) => {
        const context = `Menu entry ${index}`;
        requirePlainObject(value, context);
        if (typeof value.id !== 'string' || value.id.length === 0)
            throw new ProtocolError(`${context} ID must be a non-empty string`);
        validatePlainText(value.id, `${context} ID`);
        if (ids.has(value.id))
            throw new ProtocolError(`${context} ID is duplicated: ${value.id}`);
        ids.add(value.id);

        if (value.kind === 'separator') {
            rejectUnknownKeys(value, MENU_COMMON_KEYS, context);
            return {id: value.id, kind: 'separator'};
        }
        if (value.kind === 'label') {
            rejectUnknownKeys(value, MENU_TEXT_KEYS, context);
            validateText(value.text, 512, `${context} text`);
            if (value.text.length === 0)
                throw new ProtocolError(`${context} label is empty`);
            return {id: value.id, kind: 'label', text: value.text};
        }
        if (value.kind === 'link') {
            rejectUnknownKeys(value, MENU_LINK_KEYS, context);
            validateText(value.text, 512, `${context} text`);
            if (value.text.length === 0)
                throw new ProtocolError(`${context} link text is empty`);
            validateHttpsUri(value.uri, context);
            return {id: value.id, kind: 'link', text: value.text, uri: value.uri};
        }
        throw new ProtocolError(`${context} kind is invalid`);
    });
}

function validateHttpsUri(value, context) {
    if (typeof value !== 'string')
        throw new ProtocolError(`${context} URI must be a string`);
    if (new TextEncoder().encode(value).length > 2_048)
        throw new ProtocolError(`${context} URI exceeds 2048 bytes`);

    let uri;
    try {
        uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
    } catch (error) {
        throw new ProtocolError(`${context} URI is invalid: ${error.message}`);
    }
    if (uri.get_scheme()?.toLowerCase() !== 'https')
        throw new ProtocolError(`${context} URI must use HTTPS`);
}

function validateText(value, maximumScalars, context) {
    if (typeof value !== 'string')
        throw new ProtocolError(`${context} must be a string`);
    validatePlainText(value, context);
    if (unicodeScalarCount(value) > maximumScalars)
        throw new ProtocolError(`${context} exceeds ${maximumScalars} Unicode scalars`);
}

function validatePlainText(value, context) {
    for (let index = 0; index < value.length; index++) {
        const codePoint = value.codePointAt(index);
        if (codePoint > 0xFFFF)
            index++;
        if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
            throw new ProtocolError(`${context} contains an invalid Unicode scalar`);
        if (codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F))
            throw new ProtocolError(`${context} contains a control character`);
    }
}

function unicodeScalarCount(value) {
    let count = 0;
    for (let index = 0; index < value.length; index++) {
        if (value.codePointAt(index) > 0xFFFF)
            index++;
        count++;
    }
    return count;
}

function freezeSnapshot(snapshot) {
    if (snapshot.panel !== null)
        Object.freeze(snapshot.panel);
    for (const item of snapshot.menu)
        Object.freeze(item);
    Object.freeze(snapshot.menu);
    Object.freeze(snapshot);
}

function requirePlainObject(value, context) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new ProtocolError(`${context} must be an object`);
}

function requireBoolean(value, context) {
    if (typeof value !== 'boolean')
        throw new ProtocolError(`${context} must be boolean`);
}

function requireExact(actual, expected, context) {
    if (actual !== expected)
        throw new ProtocolError(`${context} must equal ${expected}`);
}

function rejectUnknownKeys(value, allowed, context) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new ProtocolError(`${context} contains unknown field: ${key}`);
    }
}
