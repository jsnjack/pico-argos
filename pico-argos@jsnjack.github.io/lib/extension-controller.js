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
            onChanges: (plugin, _changes, _kind, presentation) =>
                this._coordinator.queue(plugin, presentation),
            onPluginAdded: plugin => this._renderer.addPlugin(plugin),
            onPluginChanged: (plugin, previous) =>
                this._renderer.changePlugin(plugin, previous),
            onPluginRemoved: plugin => {
                this._coordinator.remove(plugin.id);
                this._renderer.removePlugin(plugin);
            },
            onEvent: event => this._recordRuntimeEvent(event),
            onPhase: (name, durationUs) =>
                this._diagnostics.recordDuration(name, durationUs),
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
        if (event.runtime === 'oneshot' && event.kind === 'started') {
            const latenessUs = Math.max(0, this._clock.nowUs() - event.deadlineUs);
            this._diagnostics.recordDuration('scheduler-lateness', latenessUs);
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
