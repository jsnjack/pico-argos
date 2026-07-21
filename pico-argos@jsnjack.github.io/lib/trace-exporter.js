// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {TraceEncoder} from './trace-encoder.js';

const EXPORT_PRIORITY = GLib.PRIORITY_LOW;
const PROJECT_CACHE_DIRECTORY = 'pico-argos';
const DIAGNOSTIC_DIRECTORY = 'diagnostics';

/** Serializes and writes one stopped trace without synchronous file I/O. */
export class TraceExporter {
    constructor(clock, traceData, document, callbacks, cacheDirectory = null) {
        this._clock = clock;
        this._traceData = traceData;
        this._encoder = new TraceEncoder(document, traceData.ring);
        this._callbacks = callbacks;
        this._cacheDirectory = cacheDirectory ?? GLib.get_user_cache_dir();
        this._cancellable = new Gio.Cancellable();
        this._directories = [];
        this._directoryIndex = 0;
        this._idleId = 0;
        this._stream = null;
        this._file = null;
        this._pendingBytes = null;
        this._pendingOffset = 0;
        this.active = false;
    }

    /** Begins asynchronous directory creation, encoding, and file output. */
    start() {
        if (this.active)
            throw new Error('Trace export is already active');

        const projectDirectory = Gio.File.new_for_path(GLib.build_filenamev([
            this._cacheDirectory,
            PROJECT_CACHE_DIRECTORY,
        ]));
        const diagnosticDirectory = projectDirectory.get_child(DIAGNOSTIC_DIRECTORY);
        this._directories = [projectDirectory, diagnosticDirectory];
        const realtimeUs = this._traceData.timing.endedRealtimeUs ?? 0;
        this._file = diagnosticDirectory.get_child(
            `trace-${this._traceData.id}-${realtimeUs}.json`);
        this.active = true;
        this._createNextDirectory();
    }

    /** Cancels pending sources and asynchronous operations. */
    cancel() {
        if (!this.active)
            return;

        this.active = false;
        if (this._idleId !== 0) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._cancellable.cancel();
        this._stream?.close_async(EXPORT_PRIORITY, null, null);
    }

    _createNextDirectory() {
        if (!this.active)
            return;
        if (this._directoryIndex === this._directories.length) {
            this._openFile();
            return;
        }

        const directory = this._directories[this._directoryIndex++];
        directory.make_directory_async(
            EXPORT_PRIORITY,
            this._cancellable,
            (source, result) => {
                try {
                    source.make_directory_finish(result);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                        this._fail('Creating trace export directory', error);
                        return;
                    }
                }
                this._createNextDirectory();
            });
    }

    _openFile() {
        this._file.replace_async(
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            EXPORT_PRIORITY,
            this._cancellable,
            (source, result) => {
                try {
                    this._stream = source.replace_finish(result);
                } catch (error) {
                    this._fail('Opening trace export', error);
                    return;
                }
                this._scheduleChunk();
            });
    }

    _scheduleChunk() {
        if (!this.active)
            return;

        this._idleId = GLib.idle_add(EXPORT_PRIORITY, () => {
            this._idleId = 0;
            if (!this.active)
                return GLib.SOURCE_REMOVE;

            const startedUs = this._clock.nowUs();
            const chunk = this._encoder.nextChunk(this._clock);
            this._callbacks.onSlice?.(this._clock.nowUs() - startedUs);
            if (chunk === null)
                this._closeFile();
            else
                this._writeChunk(chunk);
            return GLib.SOURCE_REMOVE;
        });
    }

    _writeChunk(chunk) {
        this._pendingBytes = new TextEncoder().encode(chunk);
        this._pendingOffset = 0;
        this._writePendingBytes();
    }

    _writePendingBytes() {
        const remaining = new GLib.Bytes(
            this._pendingBytes.subarray(this._pendingOffset));
        this._stream.write_bytes_async(
            remaining,
            EXPORT_PRIORITY,
            this._cancellable,
            (source, result) => {
                let written;
                try {
                    written = source.write_bytes_finish(result);
                } catch (error) {
                    this._fail('Writing trace export', error);
                    return;
                }
                if (!Number.isInteger(written) || written <= 0) {
                    this._fail(
                        'Writing trace export',
                        new Error('Output stream made no progress'));
                    return;
                }
                this._pendingOffset += written;
                if (this._pendingOffset < this._pendingBytes.length) {
                    this._writePendingBytes();
                    return;
                }
                this._pendingBytes = null;
                this._pendingOffset = 0;
                this._scheduleChunk();
            });
    }

    _closeFile() {
        this._stream.close_async(
            EXPORT_PRIORITY,
            this._cancellable,
            (source, result) => {
                try {
                    source.close_finish(result);
                } catch (error) {
                    this._fail('Closing trace export', error);
                    return;
                }

                this.active = false;
                this._callbacks.onComplete(this._file.get_path());
            });
    }

    _fail(context, error) {
        if (!this.active)
            return;

        this.active = false;
        if (this._idleId !== 0) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._cancellable.cancel();
        this._pendingBytes = null;
        this._pendingOffset = 0;
        this._stream?.close_async(EXPORT_PRIORITY, null, null);
        this._callbacks.onError(new Error(`${context}: ${error.message}`));
    }
}
