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
        this._traceState = 'unavailable';
        this._lastExportPath = null;

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
        this._traceStatus = new Adw.ActionRow({
            title: 'Trace status unavailable',
            subtitle: 'Enable pico-argos to use diagnostic capture.',
        });
        controls.add(this._traceStatus);
        const buttons = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            min_children_per_line: 1,
            max_children_per_line: 5,
            column_spacing: 6,
            row_spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 12,
            margin_end: 12,
        });
        this._traceButtons = new Map();
        for (const [id, label, action] of [
            ['record-30', 'Record 30 s', () => this._startTrace(30)],
            ['record-60', 'Record 60 s', () => this._startTrace(60)],
            ['stop', 'Stop', () => this._stopTrace()],
            ['export', 'Export', () => this._exportTrace()],
            ['reset', 'Reset', () => this._resetSummary()],
        ]) {
            const button = new Gtk.Button({label});
            button.connect('clicked', action);
            this._traceButtons.set(id, button);
            buttons.insert(button, -1);
        }
        controls.add(buttons);
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
                this._renderTraceControl(null);
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
        this._renderTraceControl(summary.traceControl ?? null);
        const healthRows = summary.runtime.plugins.map(healthRow);
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
        this._call(
            'StartTrace',
            GLib.Variant.new('(u)', [seconds]),
            () => this._refresh());
    }

    _stopTrace() {
        this._call('StopTrace', null, () => this._refresh());
    }

    _resetSummary() {
        this._call('ResetSummary', null, () => this._refresh());
    }

    _exportTrace() {
        if (this._traceState === 'recording') {
            this._stopTrace();
            return;
        }
        if (this._lastExportPath === null)
            return;
        const directory = Gio.File.new_for_path(this._lastExportPath).get_parent();
        if (directory === null)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(directory.get_uri(), null);
        } catch (error) {
            this._traceStatus.title = 'Opening the export folder failed';
            this._traceStatus.subtitle = `${error.domain ?? 'unknown'}:${error.code ?? 'unknown'}`;
        }
    }

    _renderTraceControl(control) {
        this._traceState = control?.state ?? 'unavailable';
        this._lastExportPath = control?.lastExportPath ?? null;
        if (this._traceState === 'recording') {
            this._traceStatus.title = 'Recording detailed trace';
            this._traceStatus.subtitle = 'Stop exports the captured trace immediately.';
        } else if (this._traceState === 'exporting') {
            this._traceStatus.title = 'Exporting detailed trace';
            this._traceStatus.subtitle = 'Serialization and file output run in bounded slices.';
        } else if (control?.lastExportError !== null &&
            control?.lastExportError !== undefined) {
            this._traceStatus.title = control.lastExportError;
            this._traceStatus.subtitle = 'Record another trace to retry the export.';
        } else if (this._lastExportPath !== null) {
            this._traceStatus.title = 'Latest trace export';
            this._traceStatus.subtitle = this._lastExportPath;
        } else if (this._traceState === 'idle') {
            this._traceStatus.title = 'Ready to record';
            this._traceStatus.subtitle = 'Completed traces export automatically to the cache directory.';
        } else {
            this._traceStatus.title = 'Trace status unavailable';
            this._traceStatus.subtitle = 'Enable pico-argos to use diagnostic capture.';
        }
        const idle = this._traceState === 'idle';
        this._traceButtons.get('record-30').sensitive = idle;
        this._traceButtons.get('record-60').sensitive = idle;
        this._traceButtons.get('stop').sensitive = this._traceState === 'recording';
        this._traceButtons.get('export').sensitive =
            this._traceState === 'recording' || this._lastExportPath !== null;
        this._traceButtons.get('reset').sensitive = this._traceState !== 'unavailable';
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

function healthRow(plugin) {
    const row = new Adw.ExpanderRow({
        title: plugin.id,
        subtitle: healthHeadline(plugin),
    });
    row.add_row(new Adw.ActionRow({
        title: 'Updates',
        subtitle: `${plugin.accepted} accepted · ${plugin.rawNoOps} raw no-op · ` +
            `${plugin.semanticNoOps} semantic no-op · ${plugin.skipped} skipped`,
    }));
    row.add_row(new Adw.ActionRow({
        title: 'Execution',
        subtitle: `${plugin.restarts} restarts · ${plugin.timeouts} timeouts · ` +
            `${plugin.outputRejections} rejected · last child ` +
            `${formatDurationUs(plugin.lastChildRuntimeUs)} · ` +
            `backoff ${plugin.currentBackoffMs === null
                ? 'none'
                : `${plugin.currentBackoffMs} ms`}`,
    }));
    row.add_row(new Adw.ActionRow({
        title: 'Throughput',
        subtitle: `${plugin.messages} messages · ` +
            `${plugin.messageRatePerSecond.toFixed(2)} msg/s · ` +
            `${plugin.stdoutBytes} B stdout · ${plugin.stderrBytes} B stderr · ` +
            `${plugin.byteRatePerMinute.toFixed(0)} B/min · ` +
            `${(plugin.noOpRate * 100).toFixed(1)}% no-op`,
    }));
    row.add_row(new Adw.ActionRow({
        title: 'Stream and mitigation',
        subtitle: `uptime ${formatDurationUs(plugin.streamUptimeUs)} · ` +
            `heartbeat age ${formatDurationUs(plugin.heartbeatAgeUs)} · ` +
            `nice ${plugin.niceRequested === null
                ? 'disabled'
                : plugin.niceApplied === false ? 'unavailable' : plugin.niceRequested}`,
    }));
    return row;
}

function healthHeadline(plugin) {
    const success = plugin.lastSuccessUs === null
        ? 'never updated'
        : `last success ${formatDurationUs(
            Math.max(0, GLib.get_monotonic_time() - plugin.lastSuccessUs))} ago`;
    const failure = plugin.lastFailure === null
        ? plugin.lastSuccessUs === null ? 'waiting for first update' : 'healthy'
        : `last failure: ${failureLabel(plugin.lastFailure.kind)}`;
    return `${plugin.mode} · ${plugin.processState} · ${success} · ${failure}`;
}

function failureLabel(kind) {
    const labels = {
        'byte-rate': 'stdout rate limit',
        'heartbeat-timeout': 'heartbeat timeout',
        'line-limit': 'line size limit',
        'message-rate': 'message rate limit',
        'nonzero-exit': 'plugin exited with an error',
        'protocol': 'invalid plugin output',
        'spawn': 'plugin could not start',
        'startup-timeout': 'startup timeout',
        'stderr-limit': 'stderr size limit',
        'stderr-rate': 'stderr rate limit',
        'stdout-limit': 'stdout size limit',
        'timeout': 'execution timeout',
        'utf8': 'invalid UTF-8 output',
    };
    return labels[kind] ?? kind.replaceAll('-', ' ');
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
