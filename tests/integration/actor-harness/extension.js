// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
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
        // Closing a menu is not fully synchronous even with PopupAnimation.NONE;
        // destroying it here, well after _runAssertions closed it, gives any
        // deferred BoxPointer teardown time to finish first.
        this._footerCheck?.destroy();
        this._footerCheck = null;
        delete Main.panel.statusArea[TEST_ROLE];
        delete Main.panel.statusArea[`${TEST_ROLE}-secondary`];
        delete Main.panel.statusArea[`${TEST_ROLE}-footer-check`];
    }

    _runAssertions() {
        this._diagnostics = new Diagnostics();
        let useExplicitPanelRedraw = true;
        const actions = {
            useExplicitPanelRedraw: () => useExplicitPanelRedraw,
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
        let panelRedraws = 0;
        const queuePanelRedraw = this._indicator.actor.queue_redraw.bind(
            this._indicator.actor);
        this._indicator.actor.queue_redraw = () => {
            panelRedraws++;
            queuePanelRedraw();
        };

        this._assertMenuOpensBeforeAnyContent(actions);

        const initial = presentation('00000', baseMenu());
        this._indicator.applyPresentation(initial);
        const initialized = mutations(this._diagnostics);
        const initializedRedraws = panelRedraws;
        assert(initialized['actor-creations'] === 8,
            'Panel initialization did not create exactly eight owned actors ' +
            '(four persistent leaves plus the four eagerly built footer items)');

        for (let index = 0; index < 10_000; index++)
            this._indicator.applyPresentation(initial);
        assertMutationsEqual(
            mutations(this._diagnostics),
            initialized,
            'Identical refreshes mutated actor properties');
        assert(panelRedraws === initializedRedraws,
            'Identical refreshes queued panel redraws');

        for (let index = 0; index < 10_000; index++) {
            this._indicator.applyPresentation(
                presentation(String(index).padStart(5, '0'), baseMenu()));
        }
        const changed = mutations(this._diagnostics);
        assert(panelRedraws - initializedRedraws ===
            changed['label-text-writes'] - initialized['label-text-writes'],
        'Changed panel text did not queue exactly one full panel redraw per write');
        assert(changed['actor-creations'] === initialized['actor-creations'] &&
            changed['actor-destructions'] === initialized['actor-destructions'],
        'Changing text created or destroyed an actor');

        useExplicitPanelRedraw = false;
        const beforeLabelOnly = mutations(this._diagnostics);
        const redrawsBeforeLabelOnly = panelRedraws;
        for (let index = 10_000; index < 20_000; index++) {
            this._indicator.applyPresentation(
                presentation(String(index).padStart(5, '0'), baseMenu()));
        }
        const afterLabelOnly = mutations(this._diagnostics);
        assert(panelRedraws === redrawsBeforeLabelOnly,
            'Label-only text changes queued explicit panel redraws');
        assert(afterLabelOnly['label-text-writes'] -
            beforeLabelOnly['label-text-writes'] === 10_000,
        'Label-only mode suppressed or duplicated text writes');
        assert(afterLabelOnly['actor-creations'] ===
            beforeLabelOnly['actor-creations'] &&
            afterLabelOnly['actor-destructions'] ===
            beforeLabelOnly['actor-destructions'],
        'Label-only text changes created or destroyed an actor');
        useExplicitPanelRedraw = true;

        assert(changed['actor-creations'] === 8,
            'Closed menu created actors beyond the eagerly built footer before first open');
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

    /**
     * Regression test for a real bug: GNOME Shell's PopupMenu silently
     * refuses to open (isOpen stays false, no error) when its box has zero
     * children. A plugin indicator whose menu content is built only on first
     * open therefore had a menu that could never open by any means,
     * including clicking it or calling menu.toggle() directly. Verifies the
     * eagerly built footer keeps the box non-empty from attach onward, using
     * a disposable indicator so it does not disturb the primary indicator's
     * own open-on-first-use assertions below.
     */
    _assertMenuOpensBeforeAnyContent(actions) {
        const plugin = fixturePlugin(
            'actor-footer-check',
            30,
            {mode: 'oneshot', refreshOnOpen: true});
        this._footerCheck = new PluginIndicator(
            plugin,
            {nowUs: () => GLib.get_monotonic_time()},
            new Diagnostics(),
            actions);
        Main.panel.addToStatusArea(
            `${TEST_ROLE}-footer-check`, this._footerCheck.actor, 2, 'right');
        this._footerCheck.attach();
        assert(this._footerCheck.actor.menu.box.get_n_children() > 0,
            'Menu box is empty before any content arrives; PopupMenu.open() ' +
            'would silently refuse to open it');
        this._footerCheck.actor.menu.toggle();
        assert(this._footerCheck.actor.menu.isOpen === true,
            'menu.toggle() did not actually open the menu before any content arrived');
        this._footerCheck.actor.menu.close(BoxPointer.PopupAnimation.NONE);

        assert(this._footerCheck._refreshItem.visible === false &&
            this._footerCheck._refreshItem.reactive === false &&
            this._footerCheck._refreshItem.can_focus === false,
        'Automatic open-refresh plugin exposed a redundant manual refresh action');

        this._footerCheck.reconfigure(fixturePlugin(
            'actor-footer-check',
            30,
            {mode: 'oneshot', refreshOnOpen: false}));
        assert(this._footerCheck._refreshItem.visible === true &&
            this._footerCheck._refreshItem.reactive === true &&
            this._footerCheck._refreshItem.can_focus === true,
        'Manual-refresh plugin did not expose its refresh action');

        this._footerCheck.reconfigure(fixturePlugin(
            'actor-footer-check',
            30,
            {mode: 'oneshot', refreshOnOpen: true}));
        assert(this._footerCheck._refreshItem.visible === false &&
            this._footerCheck._refreshItem.reactive === false &&
            this._footerCheck._refreshItem.can_focus === false,
        'Manifest reconfiguration retained a redundant manual refresh action');
    }
}

function fixturePlugin(id, order, overrides = {}) {
    return {
        id,
        manifest: {
            id,
            mode: 'stream',
            position: 'right',
            order,
            reserveTextChars: 5,
            ...overrides,
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
