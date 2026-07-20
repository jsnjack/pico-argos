// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {DistinctText} from './state.js';
import {SYNTHETIC_MODES} from './synthetic-output.js';
import {TRACE_EVENTS} from './trace.js';

const INITIAL_TEXT = 'constant 000000';
const MODE_LABELS = Object.freeze({
    [SYNTHETIC_MODES.CONSTANT]: 'Run constant output',
    [SYNTHETIC_MODES.CHANGING]: 'Run changing output',
    [SYNTHETIC_MODES.SPAWN]: 'Run spawn timing',
});
const TRACE_ACTIONS = Object.freeze([
    ['Record 30 s trace', 'startTrace'],
    ['Stop trace', 'stopTrace'],
    ['Reset summaries', 'resetDiagnostics'],
]);

/** Owns the persistent actors used by the Phase 0 performance harness. */
export class PerformanceIndicator {
    constructor(clock, diagnostics, actions) {
        this._clock = clock;
        this._diagnostics = diagnostics;
        this._signals = [];
        this._ownedActorCount = 0;

        this.actor = new PanelMenu.Button(0.5, 'pico-argos performance harness');
        this._recordActorCreation();

        this._label = new St.Label({
            text: INITIAL_TEXT,
            style_class: 'pico-argos-performance-label',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._recordActorCreation();
        this.actor.add_child(this._label);

        this._text = new DistinctText(INITIAL_TEXT, value => {
            this._label.text = value;
            this._diagnostics.recordMutation('label-text-writes');
        });

        for (const [mode, label] of Object.entries(MODE_LABELS)) {
            const item = new PopupMenu.PopupMenuItem(label);
            this._recordActorCreation();
            const signalId = item.connect('activate', () => actions.selectMode(mode));
            this._signals.push([item, signalId]);
            this.actor.menu.addMenuItem(item);
        }

        const separator = new PopupMenu.PopupSeparatorMenuItem();
        this._recordActorCreation();
        this.actor.menu.addMenuItem(separator);

        for (const [label, action] of TRACE_ACTIONS) {
            const item = new PopupMenu.PopupMenuItem(label);
            this._recordActorCreation();
            const signalId = item.connect('activate', actions[action]);
            this._signals.push([item, signalId]);
            this.actor.menu.addMenuItem(item);
        }
    }

    /** Applies changed text and returns its cycle ID, or null for a no-op. */
    applyText(text) {
        if (text === this._text.value)
            return null;

        const startedUs = this._clock.nowUs();
        const cycleId = this._diagnostics.nextCycleId();
        this._text.apply(text);
        const completedUs = this._clock.nowUs();
        this._diagnostics.recordDuration('ui-apply', completedUs - startedUs);
        this._diagnostics.recordTraceEvent(
            TRACE_EVENTS.UI_APPLY_END,
            completedUs,
            cycleId);
        return cycleId;
    }

    /** Disconnects owned signals and destroys all owned actors. */
    destroy() {
        for (const [object, signalId] of this._signals)
            object.disconnect(signalId);
        this._signals = [];

        this.actor.destroy();
        this._diagnostics.recordMutation('actor-destructions', this._ownedActorCount);
        this.actor = null;
        this._label = null;
        this._text = null;
    }

    _recordActorCreation() {
        this._ownedActorCount++;
        this._diagnostics.recordMutation('actor-creations');
    }
}
