// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    DIAGNOSTIC_BUS_NAME,
    DIAGNOSTIC_INTERFACE,
    DIAGNOSTIC_OBJECT_PATH,
} from './lib/diagnostic-service.js';
import {DURATION_BUCKETS_US} from './lib/diagnostics.js';

const REFRESH_SECONDS = 2;

/** Preferences and on-demand production health diagnostics. */
export default class PicoArgosPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._healthRows = [];
        this._phaseRows = [];
        this._refreshSourceId = 0;
        this._requestPending = false;

        window.add(this._buildGeneralPage());
        this._diagnosticsPage = this._buildDiagnosticsPage();
        window.add(this._diagnosticsPage);
        this._visibleSignalId = window.connect(
            'notify::visible-page',
            () => this._updateRefreshState());
        this._closeSignalId = window.connect('close-request', () => {
            this._destroy();
            return false;
        });
        this._updateRefreshState();
    }

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({title: 'Diagnostics overhead'});
        const modes = Gtk.StringList.new(['Summary', 'Off']);
        const row = new Adw.ComboRow({
            title: 'Persistent mode',
            subtitle: 'Summary is bounded; Off keeps only error behavior.',
            model: modes,
            selected: this._settings.get_string('diagnostics-mode') === 'off' ? 1 : 0,
        });
        row.connect('notify::selected', () => this._settings.set_string(
            'diagnostics-mode',
            row.selected === 1 ? 'off' : 'summary'));
        group.add(row);
        page.add(group);
        return page;
    }

    _buildDiagnosticsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Diagnostics',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        const controls = new Adw.PreferencesGroup({title: 'Capture'});
        const controlRow = new Adw.ActionRow({
            title: 'Detailed trace',
            subtitle: 'Exports automatically below the XDG cache directory.',
        });
        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        for (const [label, action] of [
            ['Record 30 s', () => this._startTrace(30)],
            ['Record 60 s', () => this._startTrace(60)],
            ['Stop', () => this._call('StopTrace')],
            ['Export', () => this._call('StopTrace')],
            ['Reset', () => this._call('ResetSummary')],
        ]) {
            const button = new Gtk.Button({label});
            button.connect('clicked', action);
            buttons.append(button);
        }
        controlRow.add_suffix(buttons);
        controls.add(controlRow);
        page.add(controls);

        this._healthGroup = new Adw.PreferencesGroup({title: 'Plugin health'});
        this._healthStatus = new Adw.ActionRow({
            title: 'Open the extension to load health',
            subtitle: 'The view refreshes only while this page is visible.',
        });
        this._healthGroup.add(this._healthStatus);
        page.add(this._healthGroup);
        this._phaseGroup = new Adw.PreferencesGroup({title: 'Synchronous phases'});
        page.add(this._phaseGroup);
        this._mutationGroup = new Adw.PreferencesGroup({title: 'Actor mutations'});
        this._mutationRow = new Adw.ActionRow({title: 'Bounded mutation counters'});
        this._mutationGroup.add(this._mutationRow);
        page.add(this._mutationGroup);
        return page;
    }

    _updateRefreshState() {
        const visible = this._window.get_visible_page() === this._diagnosticsPage;
        if (visible && this._refreshSourceId === 0) {
            this._refresh();
            this._refreshSourceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                REFRESH_SECONDS,
                () => {
                    this._refresh();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!visible && this._refreshSourceId !== 0) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
    }

    _refresh() {
        if (this._requestPending)
            return;
        this._requestPending = true;
        this._call('GetSummary', null, result => {
            this._requestPending = false;
            if (this._window === null)
                return;
            if (result === null) {
                this._replaceRows(this._healthGroup, this._healthRows, []);
                this._healthRows = [];
                this._healthStatus.title = 'Extension diagnostics unavailable';
                this._healthStatus.subtitle = 'Enable pico-argos to inspect live plugin health.';
                return;
            }
            const [json] = result.deepUnpack();
            this._renderSummary(JSON.parse(json));
        });
    }

    _renderSummary(summary) {
        this._healthStatus.title = 'Live bounded summary';
        this._healthStatus.subtitle = summary.registryErrors.length === 0
            ? 'No manifest or admission errors.'
            : `${summary.registryErrors.length} bounded registry/admission errors.`;
        const healthRows = summary.runtime.plugins.map(plugin => new Adw.ActionRow({
            title: plugin.id,
            subtitle: healthSubtitle(plugin),
        }));
        this._replaceRows(this._healthGroup, this._healthRows, healthRows);
        this._healthRows = healthRows;

        const phaseRows = Object.entries(summary.diagnostics.phases)
            .filter(([_name, phase]) => phase.count !== 0)
            .map(([name, phase]) => new Adw.ActionRow({
                title: name,
                subtitle: phaseSubtitle(phase),
            }));
        this._replaceRows(this._phaseGroup, this._phaseRows, phaseRows);
        this._phaseRows = phaseRows;
        this._mutationRow.subtitle = Object.entries(summary.diagnostics.mutations)
            .map(([name, count]) => `${name} ${count}`)
            .join(' · ');
    }

    _replaceRows(group, current, next) {
        for (const row of current)
            group.remove(row);
        for (const row of next)
            group.add(row);
    }

    _startTrace(seconds) {
        this._call('StartTrace', GLib.Variant.new('(u)', [seconds]));
    }

    _call(method, parameters = null, callback = null) {
        Gio.DBus.session.call(
            DIAGNOSTIC_BUS_NAME,
            DIAGNOSTIC_OBJECT_PATH,
            DIAGNOSTIC_INTERFACE,
            method,
            parameters,
            null,
            Gio.DBusCallFlags.NONE,
            3_000,
            null,
            (connection, result) => {
                let value = null;
                try {
                    value = connection.call_finish(result);
                } catch (_error) {
                    // The live extension may be disabled while preferences remain open.
                }
                callback?.(value);
            });
    }

    _destroy() {
        if (this._refreshSourceId !== 0) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        if (this._visibleSignalId !== 0) {
            this._window.disconnect(this._visibleSignalId);
            this._visibleSignalId = 0;
        }
        if (this._closeSignalId !== 0) {
            this._window.disconnect(this._closeSignalId);
            this._closeSignalId = 0;
        }
        this._settings = null;
        this._window = null;
    }
}

function healthSubtitle(plugin) {
    const success = plugin.lastSuccessUs === null
        ? 'never updated'
        : `last success ${formatDurationUs(
            Math.max(0, GLib.get_monotonic_time() - plugin.lastSuccessUs))} ago`;
    const failure = plugin.lastFailure === null
        ? 'no failure'
        : `failure ${plugin.lastFailure.kind}`;
    return `${plugin.mode} · ${plugin.processState} · ${success} · ${failure} · ` +
        `${plugin.accepted} accepted, ${plugin.rawNoOps} raw no-op, ` +
        `${plugin.semanticNoOps} semantic no-op, ${plugin.skipped} skipped, ` +
        `${plugin.restarts} restarts, ${plugin.timeouts} timeouts, ` +
        `${plugin.outputRejections} rejected · ${plugin.messages} messages, ` +
        `${plugin.messageRatePerSecond.toFixed(2)} msg/s, ` +
        `${plugin.stdoutBytes} B stdout, ${plugin.stderrBytes} B stderr, ` +
        `${plugin.byteRatePerMinute.toFixed(0)} B/min · ` +
        `${(plugin.noOpRate * 100).toFixed(1)}% no-op · ` +
        `last child ${formatDurationUs(plugin.lastChildRuntimeUs)}, ` +
        `uptime ${formatDurationUs(plugin.streamUptimeUs)}, ` +
        `heartbeat age ${formatDurationUs(plugin.heartbeatAgeUs)}, ` +
        `backoff ${plugin.currentBackoffMs === null ? 'none' : `${plugin.currentBackoffMs} ms`} · ` +
        `nice ${plugin.niceRequested === null
            ? 'disabled'
            : plugin.niceApplied === false ? 'unavailable' : plugin.niceRequested}`;
}

function phaseSubtitle(phase) {
    const p50 = percentileBound(phase, 0.50);
    const p95 = percentileBound(phase, 0.95);
    const p99 = percentileBound(phase, 0.99);
    return `${phase.count} samples · p50 ${p50} · p95 ${p95} · p99 ${p99} · ` +
        `max ${formatDurationUs(phase.maximumUs)}`;
}

function percentileBound(phase, percentile) {
    const target = Math.ceil(phase.count * percentile);
    let cumulative = 0;
    for (let index = 0; index < phase.buckets.length; index++) {
        cumulative += phase.buckets[index];
        if (cumulative >= target) {
            const bound = DURATION_BUCKETS_US[index];
            return Number.isFinite(bound) ? formatDurationUs(bound) : '>10 ms';
        }
    }
    return 'n/a';
}

function formatDurationUs(value) {
    if (value === null)
        return 'n/a';
    if (value < 1_000)
        return `${value} µs`;
    return `${(value / 1_000).toFixed(2)} ms`;
}
