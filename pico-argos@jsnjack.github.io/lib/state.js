// SPDX-License-Identifier: GPL-3.0-or-later

import {parseProtocolMessage} from './protocol.js';

const PANEL_FIELDS = [
    'visible',
    'text',
    'icon',
    'appearance',
    'accessibleName',
    'severity',
];
const ERROR_PANEL = Object.freeze({
    visible: true,
    text: null,
    icon: 'dialog-error-symbolic',
    appearance: 'compact',
    accessibleName: 'Plugin error',
    severity: 'critical',
});

/** Applies text only when its semantic value changes. */
export class DistinctText {
    constructor(initialValue, write) {
        if (typeof initialValue !== 'string')
            throw new TypeError('Initial text must be a string');
        if (typeof write !== 'function')
            throw new TypeError('Text writer must be a function');

        this._value = initialValue;
        this._write = write;
    }

    /** Returns the currently applied text. */
    get value() {
        return this._value;
    }

    /** Writes changed text and returns whether a write occurred. */
    apply(value) {
        if (typeof value !== 'string')
            throw new TypeError('Text must be a string');
        if (value === this._value)
            return false;

        this._write(value);
        this._value = value;
        return true;
    }
}

/** Suppresses raw and semantic no-ops and emits minimal explicit changes. */
export class StateStore {
    constructor(parser = (raw, options) => parseProtocolMessage(raw, options)) {
        this._parser = parser;
        this._entries = new Map();
    }

    /** Accepts one raw snapshot string for a plugin. */
    accept(pluginId, raw) {
        const processed = this.acceptProtocol(pluginId, raw);
        if (processed.message.kind !== 'snapshot')
            throw new Error('StateStore accepts snapshots only');
        return processed.state;
    }

    /** Raw-compares, parses once, and accepts a snapshot or stream heartbeat. */
    acceptProtocol(pluginId, raw, options = {}) {
        const previous = this._entries.get(pluginId);
        options.observe?.('raw-compare-end');
        if (previous?.raw === raw && !previous.failureActive && !previous.stale) {
            return {
                message: {kind: 'snapshot', snapshot: previous.validSnapshot},
                state: {
                    kind: 'raw-no-op',
                    snapshot: previous.validSnapshot,
                    changes: null,
                },
            };
        }

        const {
            validateSnapshot = null,
            observe = null,
            ...parserOptions
        } = options;
        observe?.('parse-begin');
        let message;
        try {
            message = this._parser(raw, parserOptions);
        } finally {
            observe?.('parse-end');
        }
        if (message.kind === 'heartbeat' || message.kind === 'action-result') {
            observe?.('validate-end');
            return {message, state: null};
        }
        try {
            validateSnapshot?.(message.snapshot);
        } finally {
            observe?.('validate-end');
        }

        const snapshot = message.snapshot;
        const changes = previous === undefined
            ? initialChanges(snapshot)
            : withStaleChange(
                diffSnapshots(previous.effectiveSnapshot, snapshot),
                previous.stale);
        this._entries.set(pluginId, {
            raw,
            validSnapshot: snapshot,
            effectiveSnapshot: snapshot,
            failureActive: false,
            stale: false,
        });
        observe?.('semantic-diff-end');

        if (changes === null) {
            return {
                message,
                state: {kind: 'semantic-no-op', snapshot, changes: null},
            };
        }
        return {message, state: {kind: 'changed', snapshot, changes}};
    }

    /** Returns the last valid semantic snapshot for a plugin. */
    get(pluginId) {
        return this._entries.get(pluginId)?.validSnapshot ?? null;
    }

    /** Returns the snapshot currently presented after failure policy. */
    getEffective(pluginId) {
        return this._entries.get(pluginId)?.effectiveSnapshot ?? null;
    }

    /** Returns the complete latest model consumed by the coalescing renderer. */
    getPresentation(pluginId) {
        const entry = this._entries.get(pluginId);
        if (entry === undefined)
            return null;
        return Object.freeze({
            snapshot: entry.effectiveSnapshot,
            stale: entry.stale,
        });
    }

    /** Applies one failure policy without discarding the last valid state. */
    applyFailure(pluginId, policy) {
        let entry = this._entries.get(pluginId);
        if (entry === undefined && policy === 'show-error') {
            entry = {
                raw: null,
                validSnapshot: null,
                effectiveSnapshot: Object.freeze({panel: null, menu: Object.freeze([])}),
                failureActive: false,
                stale: false,
            };
            this._entries.set(pluginId, entry);
        }
        if (entry === undefined || policy === 'keep-last') {
            if (entry !== undefined)
                entry.failureActive = true;
            return {kind: 'failure-no-op', changes: null};
        }
        if (policy !== 'hide' && policy !== 'show-error')
            throw new RangeError(`Unsupported failure policy: ${policy}`);

        const effectiveSnapshot = Object.freeze({
            panel: policy === 'hide' ? null : ERROR_PANEL,
            menu: entry.validSnapshot?.menu ?? Object.freeze([]),
        });
        const changes = diffSnapshots(entry.effectiveSnapshot, effectiveSnapshot);
        entry.effectiveSnapshot = effectiveSnapshot;
        entry.failureActive = true;
        if (changes === null)
            return {kind: 'failure-no-op', changes: null};
        return {kind: 'failure-changed', changes};
    }

    /** Applies or clears one fixed visual staleness transition. */
    setStale(pluginId, stale) {
        const entry = this._entries.get(pluginId);
        if (entry === undefined || entry.stale === stale)
            return {kind: 'stale-no-op', changes: null};
        entry.stale = stale;
        return {kind: 'stale-changed', changes: {panel: null, menu: null, stale}};
    }

    /** Removes and returns the last valid semantic snapshot for a plugin. */
    remove(pluginId) {
        const snapshot = this.get(pluginId);
        this._entries.delete(pluginId);
        return snapshot;
    }

    /** Forces the next output through parse and validation after reconfiguration. */
    invalidateRaw(pluginId) {
        const entry = this._entries.get(pluginId);
        if (entry !== undefined)
            entry.raw = null;
    }

    /** Clears all retained raw and semantic state. */
    clear() {
        this._entries.clear();
    }
}

/** Compares two normalized snapshots by presentation fields. */
export function diffSnapshots(previous, next) {
    const panel = diffPanel(previous.panel, next.panel);
    const menu = diffMenu(previous.menu, next.menu);
    if (panel === null && menu === null)
        return null;
    return {panel, menu, stale: null};
}

function withStaleChange(changes, wasStale) {
    if (!wasStale)
        return changes;
    if (changes === null)
        return {panel: null, menu: null, stale: false};
    return {...changes, stale: false};
}

function initialChanges(snapshot) {
    return {
        panel: {replace: snapshot.panel},
        menu: {
            added: snapshot.menu.map((item, index) => ({item, index})),
            removed: [],
            updated: [],
            order: snapshot.menu.map(item => item.id),
        },
        stale: false,
    };
}

function diffPanel(previous, next) {
    if (previous === null || next === null)
        return previous === next ? null : {replace: next};

    const fields = {};
    for (const field of PANEL_FIELDS) {
        if (previous[field] !== next[field])
            fields[field] = next[field];
    }
    return Object.keys(fields).length === 0 ? null : {fields};
}

function diffMenu(previous, next) {
    const previousById = new Map(previous.map(item => [item.id, item]));
    const nextById = new Map(next.map(item => [item.id, item]));
    const removed = previous
        .filter(item => !nextById.has(item.id))
        .map(item => item.id);
    const added = next
        .map((item, index) => ({item, index}))
        .filter(({item}) => !previousById.has(item.id));
    const updated = [];

    for (const item of next) {
        const oldItem = previousById.get(item.id);
        if (oldItem === undefined)
            continue;
        const changes = diffMenuItem(oldItem, item);
        if (changes !== null)
            updated.push({id: item.id, changes});
    }

    const previousOrder = previous.map(item => item.id);
    const nextOrder = next.map(item => item.id);
    const orderChanged = previousOrder.length !== nextOrder.length ||
        previousOrder.some((id, index) => id !== nextOrder[index]);
    if (removed.length === 0 && added.length === 0 && updated.length === 0 && !orderChanged)
        return null;
    return {
        added,
        removed,
        updated,
        order: orderChanged ? nextOrder : null,
    };
}

function diffMenuItem(previous, next) {
    if (previous.kind !== next.kind)
        return {replace: next};

    const fields = {};
    if (next.kind !== 'separator' && previous.text !== next.text)
        fields.text = next.text;
    if (next.kind === 'link' && previous.uri !== next.uri)
        fields.uri = next.uri;
    if (next.kind === 'action' && previous.selected !== next.selected)
        fields.selected = next.selected;
    return Object.keys(fields).length === 0 ? null : {fields};
}
