// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {MonotonicClock} from './clock.js';
import {Diagnostics} from './diagnostics.js';
import {PluginRegistry} from './plugin-registry.js';
import {ProductionRenderer} from './plugin-indicator.js';
import {ProductionDiagnostics} from './production-diagnostics.js';
import {RenderCoordinator} from './render-coordinator.js';
import {RuntimeManager} from './runtime-manager.js';
import {StageTrace} from './stage-trace.js';
import {TRACE_EVENTS} from './trace.js';

const MAX_REGISTRY_ERRORS = 32;

/** Wires and deterministically tears down the production extension modules. */
export class ExtensionController {
    constructor(extension, settings, metadata) {
        this._extension = extension;
        this._settings = settings;
        this._metadata = metadata;
        this._enabled = false;
        this._generation = 0;
        this._plugins = new Map();
        this._registryErrors = [];
    }

    enable() {
        if (this._enabled)
            throw new Error('ExtensionController is already enabled');
        this._enabled = true;
        const generation = ++this._generation;
        this._clock = new MonotonicClock();
        this._diagnostics = new Diagnostics(
            this._settings.get_string('diagnostics-mode'));
        this._stageTrace = new StageTrace(
            global.stage,
            this._clock,
            this._diagnostics);
        this._renderer = new ProductionRenderer(
            this._clock,
            this._diagnostics,
            {
                refreshOnOpen: pluginId => this._runtime?.refreshOnOpen(pluginId),
                openPreferences: () => this._extension.openPreferences(),
            });
        this._productionDiagnostics = new ProductionDiagnostics({
            settings: this._settings,
            metadata: this._metadata,
            clock: this._clock,
            diagnostics: this._diagnostics,
            stageTrace: this._stageTrace,
            getRuntimeSnapshot: () => this._runtime?.snapshot() ?? {},
            getPlugins: () => [...this._plugins.values()],
            getRegistryErrors: () => [...this._registryErrors],
        });
        this._coordinator = new RenderCoordinator({
            clock: this._clock,
            apply: (plugin, presentation) =>
                this._renderer.apply(plugin, presentation),
            onBatch: batch => this._productionDiagnostics.recordBatch(batch),
        });
        this._runtime = new RuntimeManager({
            clock: this._clock,
            onChanges: (plugin, _changes, _kind, presentation, cycleId) => {
                this._diagnostics.recordTraceEvent(
                    TRACE_EVENTS.UI_QUEUED,
                    this._clock.nowUs(),
                    cycleId);
                this._coordinator.queue(plugin, presentation, cycleId);
            },
            onPluginAdded: plugin => this._renderer.addPlugin(plugin),
            onPluginChanged: (plugin, previous) =>
                this._renderer.changePlugin(plugin, previous),
            onPluginRemoved: plugin => {
                this._coordinator.remove(plugin.id);
                this._renderer.removePlugin(plugin);
            },
            onEvent: event => {
                if (this._enabled && generation === this._generation)
                    this._recordRuntimeEvent(event);
            },
            onPhase: (name, durationUs) => {
                if (this._enabled && generation === this._generation)
                    this._diagnostics.recordDuration(name, durationUs);
            },
            nextCycleId: () => this._diagnostics.nextCycleId(),
        });
        this._registry = new PluginRegistry();

        this._productionDiagnostics.enable();
        this._runtime.start();
        this._registry.start(event => {
            if (this._enabled && generation === this._generation)
                this._onRegistryEvent(event);
        }).catch(error => {
            if (this._enabled && generation === this._generation &&
                !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                this._recordRegistryError('registry', error.message);
                console.error(`[pico-argos] Plugin discovery failed: ${error.message}`);
            }
        });
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._generation++;
        this._registry?.cancel();
        this._runtime?.stop();
        this._coordinator?.stop();
        this._productionDiagnostics?.destroy();
        this._renderer?.destroy();
        this._stageTrace?.destroy();

        this._plugins.clear();
        this._registryErrors.length = 0;
        this._registry = null;
        this._runtime = null;
        this._coordinator = null;
        this._productionDiagnostics = null;
        this._renderer = null;
        this._stageTrace = null;
        this._diagnostics = null;
        this._clock = null;
        this._extension = null;
        this._settings = null;
        this._metadata = null;
    }

    _onRegistryEvent(event) {
        if (event.kind === 'initial') {
            for (const error of event.errors)
                this._recordRegistryError(error.id, error.message);
            for (const plugin of event.plugins)
                this._setPlugin(plugin);
        } else if (event.kind === 'added' || event.kind === 'replaced') {
            this._setPlugin(event.plugin);
        } else if (event.kind === 'removed') {
            this._plugins.delete(event.id);
            this._runtime.removePlugin(event.id);
        } else if (event.kind === 'error') {
            this._recordRegistryError(event.id, event.message);
        }
    }

    _setPlugin(plugin) {
        this._plugins.set(plugin.id, plugin);
        this._runtime.setPlugin(plugin);
    }

    _recordRuntimeEvent(event) {
        if (!this._enabled || this._diagnostics === null)
            return;
        if (event.runtime === 'oneshot' && event.kind === 'started') {
            const latenessUs = Math.max(0, this._clock.nowUs() - event.deadlineUs);
            this._diagnostics.recordDuration('scheduler-lateness', latenessUs);
            this._diagnostics.recordTraceEvent(
                TRACE_EVENTS.SCHEDULED_DUE,
                event.deadlineUs,
                0);
            this._diagnostics.recordTraceEvent(
                TRACE_EVENTS.SCHEDULER_CALLBACK_BEGIN,
                this._clock.nowUs(),
                0);
        }
        const traceEvent = RUNTIME_TRACE_EVENTS[event.kind];
        if (traceEvent !== undefined) {
            this._diagnostics.recordTraceEvent(
                traceEvent,
                event.timestampUs ?? this._clock.nowUs(),
                event.cycleId ?? event.runId ?? event.error?.details?.runId ?? 0,
                event.sequence ?? 0);
        }
        if (event.runtime === 'stream' && event.kind === 'failure') {
            this._diagnostics.recordTraceEvent(
                TRACE_EVENTS.STREAM_RESTART_SCHEDULED,
                this._clock.nowUs(),
                event.error?.details?.runId ?? 0);
        }
        if (event.kind === 'limit')
            this._recordRegistryError(event.pluginId, event.message);
    }

    _recordRegistryError(id, message) {
        const existing = this._registryErrors.find(error =>
            error.id === id && error.message === message);
        if (existing !== undefined) {
            existing.count++;
            existing.lastMonotonicUs = this._clock.nowUs();
            return;
        }
        if (this._registryErrors.length === MAX_REGISTRY_ERRORS)
            this._registryErrors.shift();
        this._registryErrors.push({
            id,
            message,
            count: 1,
            lastMonotonicUs: this._clock.nowUs(),
        });
    }
}

const RUNTIME_TRACE_EVENTS = Object.freeze({
    'launch-begin': TRACE_EVENTS.LAUNCH_BEGIN,
    'spawn-return': TRACE_EVENTS.SPAWN_RETURN,
    'first-stdout-byte': TRACE_EVENTS.FIRST_STDOUT_BYTE,
    'stream-first-snapshot': TRACE_EVENTS.STREAM_FIRST_SNAPSHOT,
    'stream-line-complete': TRACE_EVENTS.STREAM_LINE_COMPLETE,
    'stream-heartbeat': TRACE_EVENTS.STREAM_HEARTBEAT,
    'stdout-eof': TRACE_EVENTS.STDOUT_EOF,
    'stderr-eof': TRACE_EVENTS.STDERR_EOF,
    'process-exit': TRACE_EVENTS.PROCESS_EXIT,
    'decode-begin': TRACE_EVENTS.DECODE_BEGIN,
    'decode-end': TRACE_EVENTS.DECODE_END,
    'raw-compare-end': TRACE_EVENTS.RAW_COMPARE_END,
    'parse-begin': TRACE_EVENTS.PARSE_BEGIN,
    'parse-end': TRACE_EVENTS.PARSE_END,
    'validate-end': TRACE_EVENTS.VALIDATE_END,
    'semantic-diff-end': TRACE_EVENTS.SEMANTIC_DIFF_END,
    'snapshot-accepted': TRACE_EVENTS.SNAPSHOT_ACCEPTED,
});
