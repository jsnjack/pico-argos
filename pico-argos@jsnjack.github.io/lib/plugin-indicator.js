// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {compareManifests} from './manifest.js';

const PANEL_BOXES = Object.freeze({
    left: 'left',
    center: 'center',
    right: 'right',
});
const APPROACH_CLASSES = Object.freeze({
    compact: 'pico-argos-appearance-compact',
    monospace: 'pico-argos-appearance-monospace',
    normal: 'pico-argos-appearance-normal',
});
const SEVERITY_CLASSES = Object.freeze({
    normal: 'pico-argos-severity-normal',
    warning: 'pico-argos-severity-warning',
    critical: 'pico-argos-severity-critical',
});

/** Owns one plugin's persistent panel leaves and lazily keyed menu actors. */
export class PluginIndicator {
    constructor(plugin, clock, diagnostics, actions) {
        this.plugin = plugin;
        this._clock = clock;
        this._diagnostics = diagnostics;
        this._actions = actions;
        this._menuBuilt = false;
        this._menuModels = Object.freeze([]);
        this._menuEntries = new Map();
        this._menuSignalId = 0;
        this._footerSignalId = 0;
        this._refreshSignalId = 0;
        this._restartSignalId = 0;
        this._ownedActorCount = 0;
        this._panel = null;
        this._stale = false;
        this._styleClass = '';
        this._reservedWidthKey = null;
        this._attached = false;

        this.actor = new PanelMenu.Button(0.5, plugin.id);
        this._recordCreation();
        this.actor.visible = false;

        this._content = new St.BoxLayout({
            style_class: 'pico-argos-content',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordCreation();
        this._icon = new St.Icon({
            style_class: 'system-status-icon pico-argos-icon',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordCreation();
        this._label = new St.Label({
            style_class: 'pico-argos-label',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._recordCreation();
        this._content.add_child(this._icon);
        this._content.add_child(this._label);
        this.actor.add_child(this._content);
        this._menuSignalId = this.actor.menu.connect(
            'open-state-changed',
            (_menu, open) => {
                if (!open)
                    return;
                this._ensureMenu();
                this._actions.refreshOnOpen(this.plugin.id);
            });
    }

    /** Updates setup-only manifest presentation without replacing actors. */
    reconfigure(plugin) {
        this.plugin = plugin;
        if (this._attached && this._panel !== null)
            this._applyReservedWidth(this._panel.appearance);
        if (this._menuBuilt) {
            const isStream = plugin.manifest.mode === 'stream';
            this._setActionState(this._refreshItem, !isStream);
            this._setActionState(this._restartItem, isStream);
        }
        if (this._panel !== null)
            this._applyStyle(this._panel.appearance, this._panel.severity, this._stale);
    }

    /** Applies theme-dependent setup only after the actor enters the stage. */
    attach() {
        this._attached = true;
        if (this._panel !== null)
            this._applyReservedWidth(this._panel.appearance);
    }

    /** Applies only values that differ from the persistent actor model. */
    applyPresentation(presentation) {
        const snapshot = presentation.snapshot;
        if (snapshot === null)
            return 0;
        const writes = this._applyPanel(snapshot.panel, presentation.stale);
        this._applyMenu(snapshot.menu);
        return writes + this._lastMenuWrites;
    }

    /** Disconnects signals and destroys every actor owned by this indicator. */
    destroy() {
        if (this._menuSignalId !== 0) {
            this.actor.menu.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }
        for (const entry of this._menuEntries.values())
            this._disconnectEntry(entry);
        this._menuEntries.clear();
        if (this._footerSignalId !== 0) {
            this._footerItem.disconnect(this._footerSignalId);
            this._footerSignalId = 0;
        }
        if (this._refreshSignalId !== 0) {
            this._refreshItem.disconnect(this._refreshSignalId);
            this._refreshSignalId = 0;
        }
        if (this._restartSignalId !== 0) {
            this._restartItem.disconnect(this._restartSignalId);
            this._restartSignalId = 0;
        }
        this.actor.destroy();
        this._diagnostics.recordMutation('actor-destructions', this._ownedActorCount);
        this._ownedActorCount = 0;
        this.actor = null;
        this._content = null;
        this._icon = null;
        this._label = null;
        this._footerItem = null;
        this._refreshItem = null;
        this._restartItem = null;
        this._reservedWidthKey = null;
        this._actions = null;
    }

    _applyPanel(panel, stale) {
        let writes = 0;
        const panelVisible = panel !== null && panel.visible;
        if (panelVisible && panel.text !== null) {
            writes += this._write(
                this._label,
                'text',
                panel.text,
                'label-text-writes');
        }
        writes += this._write(
            this._label,
            'visible',
            panelVisible && panel.text !== null,
            'visibility-writes');
        if (panelVisible && panel.icon !== null) {
            writes += this._write(
                this._icon,
                'icon_name',
                panel.icon,
                'icon-name-writes');
        }
        writes += this._write(
            this._icon,
            'visible',
            panelVisible && panel.icon !== null,
            'visibility-writes');
        if (panelVisible) {
            writes += this._write(
                this.actor,
                'accessible_name',
                panel.accessibleName ?? panel.text ?? this.plugin.id,
                'accessible-name-writes');
        }
        writes += this._write(
            this.actor,
            'visible',
            panelVisible,
            'visibility-writes');

        const appearance = panel?.appearance ?? 'normal';
        const severity = panel?.severity ?? 'normal';
        if (panelVisible) {
            writes += this._applyStyle(appearance, severity, stale);
            this._applyReservedWidth(appearance);
        }
        this._panel = panel;
        this._stale = stale;
        return writes;
    }

    _applyStyle(appearance, severity, stale) {
        const classes = [
            'pico-argos-content',
            APPROACH_CLASSES[appearance],
            SEVERITY_CLASSES[severity],
        ];
        if (stale)
            classes.push('pico-argos-stale');
        const styleClass = classes.join(' ');
        if (styleClass === this._styleClass)
            return 0;
        this._content.style_class = styleClass;
        this._styleClass = styleClass;
        this._diagnostics.recordMutation('style-class-writes');
        return 1;
    }

    _applyMenu(models) {
        this._lastMenuWrites = 0;
        this._menuModels = models;
        if (!this._menuBuilt)
            return;

        const nextById = new Map(models.map(model => [model.id, model]));
        for (const [id, entry] of [...this._menuEntries]) {
            if (!nextById.has(id))
                this._destroyEntry(id, entry);
        }
        models.forEach((model, index) => {
            let entry = this._menuEntries.get(model.id);
            if (entry !== undefined && entry.model.kind !== model.kind) {
                this._destroyEntry(model.id, entry);
                entry = undefined;
            }
            if (entry === undefined) {
                entry = this._createEntry(model, index);
            } else {
                if (model.kind !== 'separator' && entry.model.text !== model.text) {
                    entry.item.label.text = model.text;
                    this._recordMenuWrite();
                }
                if (model.kind === 'link' && entry.model.uri !== model.uri)
                    this._recordMenuWrite();
                entry.model = model;
            }
        });

        models.forEach((model, index) => {
            const item = this._menuEntries.get(model.id).item;
            if (this.actor.menu.box.get_children().indexOf(item) !== index) {
                this.actor.menu.box.set_child_at_index(item, index);
                this._recordMenuWrite();
            }
        });
    }

    _ensureMenu() {
        if (this._menuBuilt)
            return;
        const startedUs = this._clock.nowUs();
        this._menuBuilt = true;
        this._menuModels.forEach((model, index) => this._createEntry(model, index));

        this._footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._recordCreation();
        this.actor.menu.addMenuItem(this._footerSeparator);
        const isStream = this.plugin.manifest.mode === 'stream';
        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now', {
            reactive: !isStream,
            can_focus: !isStream,
        });
        this._refreshItem.visible = !isStream;
        this._recordCreation();
        this._refreshSignalId = this._refreshItem.connect(
            'activate',
            () => this._actions.refreshNow(this.plugin.id));
        this.actor.menu.addMenuItem(this._refreshItem);
        this._restartItem = new PopupMenu.PopupMenuItem('Restart plugin', {
            reactive: isStream,
            can_focus: isStream,
        });
        this._restartItem.visible = isStream;
        this._recordCreation();
        this._restartSignalId = this._restartItem.connect(
            'activate',
            () => this._actions.restartStream(this.plugin.id));
        this.actor.menu.addMenuItem(this._restartItem);
        this._footerItem = new PopupMenu.PopupMenuItem('Extension settings');
        this._recordCreation();
        this._footerSignalId = this._footerItem.connect(
            'activate',
            () => this._actions.openPreferences());
        this.actor.menu.addMenuItem(this._footerItem);
        this._diagnostics.recordDuration('menu-build', this._clock.nowUs() - startedUs);
    }

    _createEntry(model, index) {
        let item;
        let signalId = 0;
        if (model.kind === 'separator') {
            item = new PopupMenu.PopupSeparatorMenuItem();
        } else {
            item = new PopupMenu.PopupMenuItem(model.text, {
                reactive: model.kind === 'link',
                can_focus: model.kind === 'link',
            });
            if (model.kind === 'link') {
                signalId = item.connect('activate', () => {
                    const current = this._menuEntries.get(model.id)?.model;
                    if (current?.kind !== 'link')
                        return;
                    try {
                        Gio.AppInfo.launch_default_for_uri(current.uri, null);
                    } catch (error) {
                        console.error(
                            `[pico-argos] Opening link for ${this.plugin.id} failed ` +
                            `(${error.domain ?? 'unknown'}:${error.code ?? 'unknown'})`);
                    }
                });
            }
        }
        this._recordCreation();
        const entry = {item, model, signalId};
        this._menuEntries.set(model.id, entry);
        this.actor.menu.addMenuItem(item, index);
        return entry;
    }

    _destroyEntry(id, entry) {
        this._disconnectEntry(entry);
        entry.item.destroy();
        this._menuEntries.delete(id);
        this._ownedActorCount--;
        this._diagnostics.recordMutation('actor-destructions');
    }

    _disconnectEntry(entry) {
        if (entry.signalId !== 0) {
            entry.item.disconnect(entry.signalId);
            entry.signalId = 0;
        }
    }

    _applyReservedWidth(appearance) {
        const reserve = this.plugin.manifest.reserveTextChars;
        const key = `${appearance}:${reserve}`;
        if (key === this._reservedWidthKey)
            return;
        let width = -1;
        if (reserve !== 0 && appearance === 'monospace') {
            const text = this._label.clutter_text;
            const layout = Pango.Layout.new(text.get_layout().get_context());
            layout.set_font_description(text.get_font_description());
            layout.set_text('0'.repeat(reserve), -1);
            const [naturalWidth] = layout.get_pixel_size();
            width = Math.ceil(naturalWidth);
        }
        if (this._label.width !== width)
            this._label.width = width;
        this._reservedWidthKey = key;
    }

    _setActionState(item, active) {
        this._write(item, 'visible', active, 'menu-property-writes');
        this._write(item, 'reactive', active, 'menu-property-writes');
        this._write(item, 'can_focus', active, 'menu-property-writes');
    }

    _write(target, property, value, mutation) {
        if (target[property] === value)
            return 0;
        target[property] = value;
        this._diagnostics.recordMutation(mutation);
        return 1;
    }

    _recordCreation() {
        this._ownedActorCount++;
        this._diagnostics.recordMutation('actor-creations');
    }

    _recordMenuWrite() {
        this._lastMenuWrites++;
        this._diagnostics.recordMutation('menu-property-writes');
    }
}

/** Owns the dynamic status-area membership for all plugin indicators. */
export class ProductionRenderer {
    constructor(clock, diagnostics, actions) {
        this._clock = clock;
        this._diagnostics = diagnostics;
        this._actions = actions;
        this._entries = new Map();
        this._roleId = 0;
    }

    addPlugin(plugin) {
        if (this._entries.has(plugin.id))
            return;
        const indicator = new PluginIndicator(
            plugin,
            this._clock,
            this._diagnostics,
            this._actions);
        const role = `pico-argos-${++this._roleId}`;
        this._entries.set(plugin.id, {plugin, indicator, role});
        Main.panel.addToStatusArea(
            role,
            indicator.actor,
            this._positionIndex(plugin),
            PANEL_BOXES[plugin.manifest.position]);
        indicator.attach();
        this._reorder(plugin.manifest.position);
    }

    changePlugin(plugin, previous) {
        const entry = this._entries.get(plugin.id);
        if (entry === undefined) {
            this.addPlugin(plugin);
            return;
        }
        entry.plugin = plugin;
        entry.indicator.reconfigure(plugin);
        if (previous.manifest.position !== plugin.manifest.position) {
            const parent = panelBox(plugin.manifest.position);
            entry.indicator.actor.get_parent()?.remove_child(entry.indicator.actor);
            parent.insert_child_at_index(entry.indicator.actor, this._positionIndex(plugin));
            this._reorder(previous.manifest.position);
        }
        this._reorder(plugin.manifest.position);
    }

    apply(plugin, presentation) {
        return this._entries.get(plugin.id)?.indicator.applyPresentation(presentation) ?? 0;
    }

    removePlugin(plugin) {
        const entry = this._entries.get(plugin.id);
        if (entry === undefined)
            return;
        this._entries.delete(plugin.id);
        entry.indicator.destroy();
        delete Main.panel.statusArea[entry.role];
        this._reorder(plugin.manifest.position);
    }

    destroy() {
        for (const entry of this._entries.values()) {
            entry.indicator.destroy();
            delete Main.panel.statusArea[entry.role];
        }
        this._entries.clear();
        this._actions = null;
    }

    _positionIndex(plugin) {
        return [...this._entries.values()]
            .filter(entry => entry.plugin.manifest.position === plugin.manifest.position)
            .sort((left, right) => compareManifests(left.plugin.manifest, right.plugin.manifest))
            .findIndex(entry => entry.plugin.id === plugin.id);
    }

    _reorder(position) {
        const entries = [...this._entries.values()]
            .filter(entry => entry.plugin.manifest.position === position)
            .sort((left, right) => compareManifests(left.plugin.manifest, right.plugin.manifest));
        if (entries.length < 2)
            return;
        const parent = entries[0].indicator.actor.get_parent();
        if (parent === null)
            return;
        const children = parent.get_children();
        const base = Math.min(...entries.map(entry =>
            children.indexOf(entry.indicator.actor)).filter(index => index >= 0));
        entries.forEach((entry, index) => {
            const desired = base + index;
            const current = parent.get_children().indexOf(entry.indicator.actor);
            if (current !== desired)
                parent.set_child_at_index(entry.indicator.actor, desired);
        });
    }
}

function panelBox(position) {
    if (position === 'left')
        return Main.panel._leftBox;
    if (position === 'center')
        return Main.panel._centerBox;
    return Main.panel._rightBox;
}
