// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MonotonicClock} from './clock.js';
import {DiagnosticService} from './diagnostic-service.js';
import {Diagnostics} from './diagnostics.js';
import {PerformanceIndicator} from './render.js';
import {StageTrace} from './stage-trace.js';
import {SyntheticOutput, SYNTHETIC_MODES} from './synthetic-output.js';

const UPDATE_INTERVAL_MS = 250;
const SPAWN_INTERVAL_MS = 1_000;
const TRACE_DURATION_SECONDS = 30;
const MAX_SUMMARY_BYTES = 64 * 1_024;
const SYNTHETIC_COMMAND = ['/usr/bin/true'];

/** Owns the lifecycle of the Phase 0 synthetic performance harness. */
export class PerformanceController {
    constructor(settings) {
        this._settings = settings;
        this._generation = 0;
        this._timerId = 0;
        this._traceTimerId = 0;
        this._settingsSignalId = 0;
        this._spawnToken = 0;
        this._spawnProcess = null;
        this._spawnCancellable = null;
        this._mode = null;
    }

    /** Creates the harness actors, settings connection, and one workload timer. */
    enable() {
        this._generation++;
        this._clock = new MonotonicClock();
        this._diagnostics = new Diagnostics(
            this._settings.get_string('diagnostics-mode'));
        this._output = new SyntheticOutput();
        this._launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.NONE,
        });
        this._launcher.set_environ([]);
        this._stageTrace = new StageTrace(
            global.stage,
            this._clock,
            this._diagnostics);

        this._indicator = new PerformanceIndicator(
            this._clock,
            this._diagnostics,
            {
                selectMode: mode => this._selectMode(mode),
                startTrace: () => this._startTrace(),
                stopTrace: () => this._stopTrace(),
                resetDiagnostics: () => this._diagnostics.reset(),
            });
        Main.panel.addToStatusArea('pico-argos', this._indicator.actor, 0, 'right');

        this._diagnosticService = new DiagnosticService({
            getSummary: () => this._getSummary(),
            startTrace: durationSeconds => this._startTrace(durationSeconds),
            stopTrace: () => this._stopTrace(),
            resetSummary: () => this._diagnostics.reset(),
        });
        this._diagnosticService.enable();

        this._settingsSignalId = this._settings.connect(
            'changed::diagnostics-mode',
            () => this._diagnostics.setMode(
                this._settings.get_string('diagnostics-mode')));

        this._selectMode(SYNTHETIC_MODES.CONSTANT);
    }

    /** Stops new work and releases every resource created by enable. */
    disable() {
        this._generation++;
        this._diagnosticService?.destroy();
        this._diagnosticService = null;
        this._stopTimer();
        this._stopTrace();
        this._cancelSpawn();

        if (this._settingsSignalId !== 0) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        this._stageTrace?.destroy();
        this._stageTrace = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._launcher = null;
        this._output = null;
        this._diagnostics = null;
        this._clock = null;
        this._mode = null;
    }

    _selectMode(mode) {
        if (!Object.values(SYNTHETIC_MODES).includes(mode))
            throw new RangeError(`Unsupported synthetic mode: ${mode}`);
        if (mode === this._mode)
            return;

        this._stopTimer();
        this._cancelSpawn();
        this._mode = mode;
        this._output.reset();
        this._applyOutput(this._output.next(mode));

        const intervalMs = mode === SYNTHETIC_MODES.SPAWN
            ? SPAWN_INTERVAL_MS
            : UPDATE_INTERVAL_MS;
        const generation = this._generation;
        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            intervalMs,
            () => this._onTimer(generation));
    }

    _onTimer(generation) {
        if (generation !== this._generation)
            return GLib.SOURCE_REMOVE;

        const startedUs = this._clock.nowUs();
        try {
            this._applyOutput(this._output.next(this._mode));
            if (this._mode === SYNTHETIC_MODES.SPAWN)
                this._spawnSyntheticProcess(generation);
        } finally {
            this._diagnostics.recordDuration(
                'scheduler-callback',
                this._clock.nowUs() - startedUs);
        }

        return GLib.SOURCE_CONTINUE;
    }

    _applyOutput(text) {
        const cycleId = this._indicator.applyText(text);
        if (cycleId !== null)
            this._stageTrace.arm(cycleId);
    }

    _startTrace(durationSeconds = TRACE_DURATION_SECONDS) {
        if (this._diagnostics.traceActive)
            return null;

        const traceId = this._diagnostics.startTrace();
        this._traceTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            durationSeconds,
            () => {
                this._traceTimerId = 0;
                this._stageTrace.disarm();
                this._diagnostics.stopTrace();
                return GLib.SOURCE_REMOVE;
            });
        return traceId;
    }

    _stopTrace() {
        if (this._traceTimerId !== 0) {
            GLib.source_remove(this._traceTimerId);
            this._traceTimerId = 0;
        }
        this._stageTrace?.disarm();
        this._diagnostics?.stopTrace();
    }

    _getSummary() {
        const startedUs = this._clock.nowUs();
        const json = JSON.stringify(this._diagnostics.snapshot());
        const byteLength = new TextEncoder().encode(json).length;
        this._diagnostics.recordDuration(
            'get-summary',
            this._clock.nowUs() - startedUs);

        if (byteLength > MAX_SUMMARY_BYTES)
            throw new Error(`Diagnostic summary exceeds ${MAX_SUMMARY_BYTES} bytes`);
        return json;
    }

    _spawnSyntheticProcess(generation) {
        if (this._spawnProcess !== null)
            return;

        const startedUs = this._clock.nowUs();
        let process;
        try {
            process = this._launcher.spawnv(SYNTHETIC_COMMAND);
        } catch (_error) {
            this._diagnostics.recordSpawnFailure();
            return;
        } finally {
            this._diagnostics.recordDuration(
                'spawn-call',
                this._clock.nowUs() - startedUs);
        }

        const token = ++this._spawnToken;
        const cancellable = new Gio.Cancellable();
        this._spawnProcess = process;
        this._spawnCancellable = cancellable;
        try {
            process.wait_async(cancellable, (source, result) => {
                let successful = false;
                try {
                    source.wait_finish(result);
                    successful = source.get_successful();
                } catch (_error) {
                    successful = false;
                }

                if (generation !== this._generation || token !== this._spawnToken)
                    return;

                this._spawnProcess = null;
                this._spawnCancellable = null;
                if (!successful)
                    this._diagnostics.recordSpawnFailure();
            });
        } catch (_error) {
            this._spawnProcess = null;
            this._spawnCancellable = null;
            process.force_exit();
            this._diagnostics.recordSpawnFailure();
        }
    }

    _stopTimer() {
        if (this._timerId === 0)
            return;

        GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _cancelSpawn() {
        this._spawnToken++;
        const process = this._spawnProcess;
        const cancellable = this._spawnCancellable;
        this._spawnProcess = null;
        this._spawnCancellable = null;

        cancellable?.cancel();
        process?.force_exit();
    }
}
