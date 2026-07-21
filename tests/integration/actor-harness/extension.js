// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Diagnostics} from './lib/diagnostics.js';
import {PluginIndicator} from './lib/plugin-indicator.js';

const TEST_ROLE = 'pico-argos-actor-test';

/** Runs production actor assertions inside a nested GNOME Shell. */
export default class ActorHarnessExtension extends Extension {
    enable() {
        try {
            this._runAssertions();
            console.log('[pico-argos-actor-test] PASS');
        } catch (error) {
            console.error(`[pico-argos-actor-test] FAIL: ${error.message}`);
            throw error;
        }
    }

    disable() {
        this._secondary?.destroy();
        this._secondary = null;
        this._indicator?.destroy();
        this._indicator = null;
        delete Main.panel.statusArea[TEST_ROLE];
        delete Main.panel.statusArea[`${TEST_ROLE}-secondary`];
    }

    _runAssertions() {
        this._diagnostics = new Diagnostics();
        const actions = {
            refreshOnOpen() {},
            refreshNow() {},
            restartStream() {},
            openPreferences() {},
        };
        const plugin = fixturePlugin('actor-primary', 10);
        this._indicator = new PluginIndicator(
            plugin,
            {nowUs: () => GLib.get_monotonic_time()},
            this._diagnostics,
            actions);
        Main.panel.addToStatusArea(TEST_ROLE, this._indicator.actor, 0, 'right');
        this._indicator.attach();

        const initial = presentation('00000', baseMenu());
        this._indicator.applyPresentation(initial);
        const initialized = mutations(this._diagnostics);
        assert(initialized['actor-creations'] === 4,
            'Panel initialization did not create exactly four owned actors');

        for (let index = 0; index < 10_000; index++)
            this._indicator.applyPresentation(initial);
        assertMutationsEqual(
            mutations(this._diagnostics),
            initialized,
            'Identical refreshes mutated actor properties');

        for (let index = 0; index < 10_000; index++) {
            this._indicator.applyPresentation(
                presentation(String(index).padStart(5, '0'), baseMenu()));
        }
        const changed = mutations(this._diagnostics);
        assert(changed['actor-creations'] === initialized['actor-creations'] &&
            changed['actor-destructions'] === initialized['actor-destructions'],
        'Changing text created or destroyed an actor');

        assert(changed['actor-creations'] === 4,
            'Closed menu created actors before first open');
        this._indicator._ensureMenu();
        const opened = mutations(this._diagnostics);
        assert(opened['actor-creations'] === 10,
            'First menu build did not create its bounded retained actors');

        const latest = presentation('09999', baseMenu());
        this._indicator.applyPresentation(latest);
        const reopened = mutations(this._diagnostics);
        this._indicator._ensureMenu();
        this._indicator.applyPresentation(latest);
        assertMutationsEqual(
            mutations(this._diagnostics),
            reopened,
            'Reopening an unchanged menu caused a mutation');

        const updatedMenu = [
            {id: 'status', kind: 'label', text: 'Changed once'},
            baseMenu()[1],
        ];
        const beforeLabelUpdate = mutations(this._diagnostics);
        this._indicator.applyPresentation(presentation('09999', updatedMenu));
        const afterLabelUpdate = mutations(this._diagnostics);
        assert(afterLabelUpdate['menu-property-writes'] ===
            beforeLabelUpdate['menu-property-writes'] + 1,
        'Updating one menu label did not perform exactly one menu write');

        const beforeReorder = mutations(this._diagnostics);
        this._indicator.applyPresentation(
            presentation('09999', [...updatedMenu].reverse()));
        const afterReorder = mutations(this._diagnostics);
        assert(afterReorder['actor-creations'] === beforeReorder['actor-creations'] &&
            afterReorder['actor-destructions'] === beforeReorder['actor-destructions'],
        'Reordering menu items recreated an actor');

        const secondaryPlugin = fixturePlugin('actor-secondary', 20);
        this._secondary = new PluginIndicator(
            secondaryPlugin,
            {nowUs: () => GLib.get_monotonic_time()},
            this._diagnostics,
            actions);
        Main.panel.addToStatusArea(
            `${TEST_ROLE}-secondary`, this._secondary.actor, 1, 'right');
        this._secondary.attach();
        this._secondary.applyPresentation(presentation('other', Object.freeze([])));
        this._secondary.destroy();
        this._secondary = null;
        delete Main.panel.statusArea[`${TEST_ROLE}-secondary`];
        const beforeUnrelatedApply = mutations(this._diagnostics);
        this._indicator.applyPresentation(
            presentation('09999', [...updatedMenu].reverse()));
        assertMutationsEqual(
            mutations(this._diagnostics),
            beforeUnrelatedApply,
            'Removing another plugin mutated the retained indicator');
    }
}

function fixturePlugin(id, order) {
    return {
        id,
        manifest: {
            id,
            mode: 'stream',
            position: 'right',
            order,
            reserveTextChars: 5,
        },
    };
}

function baseMenu() {
    return Object.freeze([
        Object.freeze({id: 'status', kind: 'label', text: 'Stable status'}),
        Object.freeze({
            id: 'site',
            kind: 'link',
            text: 'Open example',
            uri: 'https://example.com/',
        }),
    ]);
}

function presentation(text, menu) {
    return Object.freeze({
        stale: false,
        snapshot: Object.freeze({
            panel: Object.freeze({
                visible: true,
                text,
                icon: null,
                appearance: 'monospace',
                accessibleName: 'Actor test indicator',
                severity: 'normal',
            }),
            menu,
        }),
    });
}

function mutations(diagnostics) {
    return diagnostics.snapshot().mutations;
}

function assertMutationsEqual(actual, expected, message) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
