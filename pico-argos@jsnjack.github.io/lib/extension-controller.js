// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {MonotonicClock} from './clock.js';
import {Diagnostics} from './diagnostics.js';
import {
    isPluginEnabled,
    normalizeDisabledPluginIds,
} from './plugin-enable.js';
import {PluginRegistry} from './plugin-registry.js';
import {ProductionRenderer} from './plugin-indicator.js';
import {ProductionDiagnostics} from './production-diagnostics.js';
import {RenderCoordinator} from './render-coordinator.js';
import {RuntimeManager} from './runtime-manager.js';
import {StageTrace} from './stage-trace.js';
import {TRACE_EVENTS, tracePluginId} from './trace.js';

const MAX_REGISTRY_ERRORS = 32;
const MAX_REGISTRY_ERROR_ID_CHARS = 64;
const MAX_REGISTRY_ERROR_MESSAGE_CHARS = 512;

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
        this._settingsSignalId = 0;
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
                useExplicitPanelRedraw: () => this._settings.get_boolean(
                    'performance-explicit-redraw'),
                refreshOnOpen: pluginId => this._runtime?.refreshOnOpen(pluginId),
                refreshNow: pluginId => this._runtime?.refreshNow(pluginId),
                restartStream: pluginId => this._runtime?.restartStream(pluginId),
                activateMenuAction: (pluginId, actionId) =>
                    this._runtime?.activateMenuAction(pluginId, actionId),
                openPreferences: () => this._extension.openPreferences(),
            });
        this._productionDiagnostics = new ProductionDiagnostics({
            settings: this._settings,
            metadata: this._metadata,
            clock: this._clock,
            diagnostics: this._diagnostics,
            stageTrace: this._stageTrace,
            getRuntimeSnapshot: () => ({
                ...(this._runtime?.snapshot() ?? {}),
                explicitPanelRedraw: this._settings.get_boolean(
                    'performance-explicit-redraw'),
            }),
            getPlugins: () => [...this._plugins.values()].filter(plugin =>
                isPluginEnabled(this._disabledPluginIds, plugin.id)),
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
            onPhase: (name, durationUs, pluginId = null) => {
                if (this._enabled && generation === this._generation)
                    this._productionDiagnostics.recordPhase(
                        name, durationUs, pluginId);
            },
            nextCycleId: () => this._diagnostics.nextCycleId(),
        });
        this._registry = new PluginRegistry();
        this._disabledPluginIds = normalizeDisabledPluginIds(
            this._settings.get_strv('disabled-plugins'));

        this._productionDiagnostics.enable();
        this._runtime.start();
        this._settingsSignalId = this._settings.connect(
            'changed::disabled-plugins',
            () => this._syncEnabledPlugins());
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
        if (this._settingsSignalId !== 0) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }
        this._registry?.cancel();
        this._runtime?.destroy();
        this._coordinator?.stop();
        this._productionDiagnostics?.destroy();
        this._renderer?.destroy();
        this._stageTrace?.destroy();

        this._plugins.clear();
        this._registryErrors.length = 0;
        this._disabledPluginIds = [];
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
        if (isPluginEnabled(this._disabledPluginIds, plugin.id))
            this._runtime.setPlugin(plugin);
        else
            this._runtime.removePlugin(plugin.id);
    }

    _syncEnabledPlugins() {
        const previous = this._disabledPluginIds;
        this._disabledPluginIds = normalizeDisabledPluginIds(
            this._settings.get_strv('disabled-plugins'));
        for (const plugin of this._plugins.values()) {
            const wasEnabled = isPluginEnabled(previous, plugin.id);
            const enabled = isPluginEnabled(this._disabledPluginIds, plugin.id);
            if (enabled && !wasEnabled)
                this._runtime.setPlugin(plugin);
            else if (!enabled && wasEnabled)
                this._runtime.removePlugin(plugin.id);
        }
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
                0,
                tracePluginId(event.pluginId));
            this._diagnostics.recordTraceEvent(
                TRACE_EVENTS.SCHEDULER_CALLBACK_BEGIN,
                this._clock.nowUs(),
                0,
                tracePluginId(event.pluginId));
        }
        const traceEvent = RUNTIME_TRACE_EVENTS[event.kind];
        if (traceEvent !== undefined) {
            const detailId = event.kind === 'launch-begin'
                ? tracePluginId(event.pluginId)
                : event.kind === 'snapshot-accepted'
                    ? event.runId ?? 0
                    : event.sequence ?? 0;
            this._diagnostics.recordTraceEvent(
                traceEvent,
                event.timestampUs ?? this._clock.nowUs(),
                event.cycleId ?? event.runId ?? event.error?.details?.runId ?? 0,
                detailId);
            if (event.kind === 'snapshot-accepted' && (event.sequence ?? 0) !== 0) {
                this._diagnostics.recordTraceEvent(
                    TRACE_EVENTS.SNAPSHOT_SEQUENCE,
                    event.timestampUs ?? this._clock.nowUs(),
                    event.cycleId,
                    event.sequence);
            }
        }
        if (event.kind === 'spawn-return' && event.spawned === false)
            this._diagnostics.recordSpawnFailure();
        if (event.runtime === 'stream' && event.kind === 'failure') {
            this._diagnostics.recordTraceEvent(
                TRACE_EVENTS.STREAM_RESTART_SCHEDULED,
                this._clock.nowUs(),
                event.error?.details?.runId ?? 0,
                tracePluginId(event.pluginId));
        }
        if (event.kind === 'limit')
            this._recordRegistryError(event.pluginId, event.message);
    }

    _recordRegistryError(id, message) {
        const boundedId = String(id).slice(0, MAX_REGISTRY_ERROR_ID_CHARS);
        const boundedMessage = String(message).slice(
            0,
            MAX_REGISTRY_ERROR_MESSAGE_CHARS);
        const existing = this._registryErrors.find(error =>
            error.id === boundedId && error.message === boundedMessage);
        if (existing !== undefined) {
            existing.count++;
            existing.lastMonotonicUs = this._clock.nowUs();
            return;
        }
        if (this._registryErrors.length === MAX_REGISTRY_ERRORS)
            this._registryErrors.shift();
        this._registryErrors.push({
            id: boundedId,
            message: boundedMessage,
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
