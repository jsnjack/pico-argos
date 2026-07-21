// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DiagnosticService} from './diagnostic-service.js';
import {TRACE_EVENTS, tracePluginId} from './trace.js';
import {TraceExporter} from './trace-exporter.js';

const MAX_SUMMARY_BYTES = 64 * 1_024;
const MAX_SLOW_PHASE_LOG_KEYS = 256;
const DISPLAY_CONFIG_BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const DISPLAY_CONFIG_INTERFACE = 'org.gnome.Mutter.DisplayConfig';

/** Owns production summary, trace controls, stage arming, and sanitized export. */
export class ProductionDiagnostics {
    constructor({
        settings,
        metadata,
        clock,
        diagnostics,
        stageTrace,
        getRuntimeSnapshot,
        getPlugins,
        getRegistryErrors,
    }) {
        this._settings = settings;
        this._metadata = metadata;
        this._clock = clock;
        this._diagnostics = diagnostics;
        this._stageTrace = stageTrace;
        this._getRuntimeSnapshot = getRuntimeSnapshot;
        this._getPlugins = getPlugins;
        this._getRegistryErrors = getRegistryErrors;
        this._settingsSignalId = 0;
        this._traceTimerId = 0;
        this._traceExporter = null;
        this._lastTraceLogUs = null;
        this._lastExportPath = null;
        this._lastExportError = null;
        this._slowPhaseLogs = new Map();
        this._monitorCancellable = new Gio.Cancellable();
        this._monitorRequestPending = false;
        this._monitorRefreshRates = new Map();
    }

    enable() {
        this._service = new DiagnosticService({
            getSummary: () => this.getSummary(),
            startTrace: durationSeconds => this.startTrace(durationSeconds),
            stopTrace: () => this.stopTrace(),
            resetSummary: () => this._diagnostics.reset(),
        });
        this._service.enable();
        this._refreshMonitorConfiguration();
        this._settingsSignalId = this._settings.connect(
            'changed::diagnostics-mode',
            () => this._diagnostics.setMode(
                this._settings.get_string('diagnostics-mode')));
    }

    /** Records the one coalesced UI phase and arms stage hooks only on writes. */
    recordBatch(batch) {
        this.recordPhase('ui-queue-wait', batch.queueWaitUs, 'render');
        this.recordPhase(
            'ui-apply', batch.applyEndUs - batch.applyBeginUs, 'render');
        if (batch.writes === 0)
            return;
        const cycleId = batch.cycleId;
        this._diagnostics.recordTraceEvent(
            TRACE_EVENTS.UI_APPLY_BEGIN,
            batch.applyBeginUs,
            cycleId);
        this._diagnostics.recordTraceEvent(
            TRACE_EVENTS.UI_APPLY_END,
            batch.applyEndUs,
            cycleId);
        this._stageTrace.arm(cycleId);
    }

    /** Records one phase and rate-limits warnings for threshold violations. */
    recordPhase(name, durationUs, pluginId = null) {
        const violated = this._diagnostics.recordDuration(name, durationUs);
        if (!violated)
            return;
        const key = `${pluginId ?? 'global'}:${name}`;
        const nowUs = this._clock.nowUs();
        const lastUs = this._slowPhaseLogs.get(key);
        if (lastUs !== undefined && nowUs - lastUs < 60_000_000)
            return;
        if (lastUs !== undefined)
            this._slowPhaseLogs.delete(key);
        else if (this._slowPhaseLogs.size === MAX_SLOW_PHASE_LOG_KEYS)
            this._slowPhaseLogs.delete(this._slowPhaseLogs.keys().next().value);
        this._slowPhaseLogs.set(key, nowUs);
        console.warn(
            `[pico-argos] Slow ${name} phase for ${pluginId ?? 'global'}: ` +
            `${durationUs} µs`);
    }

    startTrace(durationSeconds) {
        if (this._diagnostics.traceActive || this._traceExporter !== null)
            return null;
        const traceId = this._diagnostics.startTrace(this._timing());
        this._lastExportError = null;
        this._refreshMonitorConfiguration();
        this._traceTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            durationSeconds,
            () => {
                this._traceTimerId = 0;
                this._completeTrace();
                return GLib.SOURCE_REMOVE;
            });
        return traceId;
    }

    stopTrace() {
        if (this._traceTimerId !== 0) {
            GLib.source_remove(this._traceTimerId);
            this._traceTimerId = 0;
        }
        if (this._diagnostics.traceActive)
            this._completeTrace();
    }

    getSummary() {
        const startedUs = this._clock.nowUs();
        const document = {
            formatVersion: 1,
            project: 'pico-argos',
            diagnostics: this._diagnostics.snapshot(),
            runtime: this._getRuntimeSnapshot(),
            registryErrors: this._getRegistryErrors(),
            traceControl: this._traceControlSnapshot(),
        };
        const json = JSON.stringify(document);
        this.recordPhase('get-summary', this._clock.nowUs() - startedUs);
        if (new TextEncoder().encode(json).length > MAX_SUMMARY_BYTES)
            throw new Error(`Diagnostic summary exceeds ${MAX_SUMMARY_BYTES} bytes`);
        return json;
    }

    destroy() {
        this._service?.destroy();
        this._service = null;
        if (this._settingsSignalId !== 0) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }
        if (this._traceTimerId !== 0) {
            GLib.source_remove(this._traceTimerId);
            this._traceTimerId = 0;
        }
        this._stageTrace.disarm();
        if (this._diagnostics.traceActive)
            this._diagnostics.stopTrace(this._timing());
        this._traceExporter?.cancel();
        this._traceExporter = null;
        this._monitorCancellable.cancel();
        this._monitorRefreshRates.clear();
        this._slowPhaseLogs.clear();
        this._settings = null;
    }

    _completeTrace() {
        this._stageTrace.disarm();
        this._diagnostics.stopTrace(this._timing());
        const traceData = this._diagnostics.stoppedTrace();
        const document = this._buildTraceDocument(traceData);
        this._traceExporter = new TraceExporter(
            this._clock,
            traceData,
            document,
            {
                onSlice: durationUs => this.recordPhase(
                    'trace-serialize', durationUs),
                onComplete: path => {
                    this._traceExporter = null;
                    this._lastExportPath = path;
                    this._lastExportError = null;
                    this._service?.emitTraceReady(traceData.id, path);
                    const nowUs = this._clock.nowUs();
                    if (this._lastTraceLogUs === null ||
                        nowUs - this._lastTraceLogUs >= 60_000_000) {
                        this._lastTraceLogUs = nowUs;
                        console.log(`[pico-argos] Diagnostic trace ready: ${path}`);
                    }
                },
                onError: error => {
                    this._traceExporter = null;
                    this._lastExportError = 'Trace export failed';
                    console.error(`[pico-argos] Trace export failed: ${error.message}`);
                },
            });
        this._traceExporter.start();
    }

    _buildTraceDocument(traceData) {
        return {
            formatVersion: 1,
            project: 'pico-argos',
            extensionVersion: this._metadata.version,
            boundary: 'Stage events are Shell-side timing, not GPU, KMS, or physical presentation.',
            environment: {
                shellVersion: Config.PACKAGE_VERSION,
                gjsVersion: System.version,
                monitors: Main.layoutManager.monitors.map(monitor => ({
                    index: monitor.index,
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    refreshRate: this._monitorRefreshRates.get(
                        monitorPositionKey(monitor.x, monitor.y)) ??
                        monitor.refreshRate ?? monitor.refresh_rate ?? null,
                })),
            },
            manifests: this._getPlugins().map(sanitizePlugin),
            runtime: this._getRuntimeSnapshot(),
            registryErrors: this._getRegistryErrors(),
            trace: {
                id: traceData.id,
                timing: traceData.timing,
                ...traceData.ring.summary(),
                eventSchema: ['eventId', 'timestampUs', 'correlationId', 'detailId'],
                eventTypes: Object.fromEntries(Object.entries(TRACE_EVENTS)
                    .map(([name, id]) => [id, name])),
            },
            summary: this._diagnostics.snapshot(),
        };
    }

    _timing() {
        return {
            monotonicUs: this._clock.nowUs(),
            realtimeUs: this._clock.realtimeUs(),
        };
    }

    _traceControlSnapshot() {
        return {
            state: this._diagnostics.traceActive
                ? 'recording'
                : this._traceExporter !== null ? 'exporting' : 'idle',
            lastExportPath: this._lastExportPath,
            lastExportError: this._lastExportError,
        };
    }

    _refreshMonitorConfiguration() {
        if (this._monitorRequestPending || this._monitorCancellable.is_cancelled())
            return;
        this._monitorRequestPending = true;
        Gio.DBus.session.call(
            DISPLAY_CONFIG_BUS_NAME,
            DISPLAY_CONFIG_OBJECT_PATH,
            DISPLAY_CONFIG_INTERFACE,
            'GetCurrentState',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            1_000,
            this._monitorCancellable,
            (connection, result) => {
                this._monitorRequestPending = false;
                let reply;
                try {
                    reply = connection.call_finish(result).deepUnpack();
                } catch (_error) {
                    return;
                }
                this._monitorRefreshRates = monitorRefreshRates(reply);
            });
    }
}

function monitorRefreshRates(reply) {
    const physicalRates = new Map();
    for (const [specification, modes] of reply[1] ?? []) {
        const currentMode = modes.find(mode =>
            unpackVariant(mode[6]?.['is-current']) === true);
        const refreshRate = currentMode?.[3];
        if (Number.isFinite(refreshRate))
            physicalRates.set(specification[0], refreshRate);
    }

    const logicalRates = new Map();
    for (const logicalMonitor of reply[2] ?? []) {
        const connectors = logicalMonitor[5].map(specification => specification[0]);
        const rates = connectors
            .map(connector => physicalRates.get(connector))
            .filter(rate => rate !== undefined);
        if (rates.length > 0) {
            logicalRates.set(
                monitorPositionKey(logicalMonitor[0], logicalMonitor[1]),
                Math.max(...rates));
        }
    }
    return logicalRates;
}

function unpackVariant(value) {
    return typeof value?.deepUnpack === 'function' ? value.deepUnpack() : value;
}

function monitorPositionKey(x, y) {
    return `${x}:${y}`;
}

function sanitizePlugin(plugin) {
    const manifest = plugin.manifest;
    return {
        id: manifest.id,
        tracePluginId: tracePluginId(manifest.id),
        mode: manifest.mode,
        position: manifest.position,
        order: manifest.order,
        nice: manifest.nice,
        reserveTextChars: manifest.reserveTextChars,
        failurePolicy: manifest.failurePolicy,
        maxStaleMs: manifest.maxStaleMs,
        intervalMs: manifest.intervalMs ?? null,
        timeoutMs: manifest.timeoutMs ?? null,
        startupTimeoutMs: manifest.startupTimeoutMs ?? null,
        heartbeatTimeoutMs: manifest.heartbeatTimeoutMs ?? null,
        maxMessagesPerSecond: manifest.maxMessagesPerSecond ?? null,
        maxBytesPerMinute: manifest.maxBytesPerMinute ?? null,
    };
}
