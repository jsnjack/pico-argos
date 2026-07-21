// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import System from 'system';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DiagnosticService} from './diagnostic-service.js';
import {TRACE_EVENTS} from './trace.js';
import {TraceExporter} from './trace-exporter.js';

const MAX_SUMMARY_BYTES = 64 * 1_024;

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
        this._slowPhaseLogs = new Map();
    }

    enable() {
        this._service = new DiagnosticService({
            getSummary: () => this.getSummary(),
            startTrace: durationSeconds => this.startTrace(durationSeconds),
            stopTrace: () => this.stopTrace(),
            resetSummary: () => this._diagnostics.reset(),
        });
        this._service.enable();
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
        this._slowPhaseLogs.set(key, nowUs);
        console.warn(
            `[pico-argos] Slow ${name} phase for ${pluginId ?? 'global'}: ` +
            `${durationUs} µs`);
    }

    startTrace(durationSeconds) {
        if (this._diagnostics.traceActive || this._traceExporter !== null)
            return null;
        const traceId = this._diagnostics.startTrace(this._timing());
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
                    refreshRate: monitor.refreshRate ?? monitor.refresh_rate ?? null,
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
}

function sanitizePlugin(plugin) {
    const manifest = plugin.manifest;
    return {
        id: manifest.id,
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
