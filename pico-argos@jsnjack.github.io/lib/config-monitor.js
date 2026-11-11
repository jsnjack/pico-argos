// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    configPath,
    DEFAULT_CONFIG,
    MAX_CONFIG_BYTES,
    parseConfig,
} from './config.js';
import {
    loadBoundedContents,
    queryInfo,
    SECURITY_ATTRIBUTES,
    validateOwnedFile,
} from './plugin-registry.js';

const RELOAD_DELAY_MS = 250;

/**
 * Loads config.json without synchronous file I/O and reports each valid
 * change. A missing file is the default configuration; an invalid file is
 * reported and the last valid configuration stays in effect.
 */
export class ConfigMonitor {
    constructor({path = configPath(), onChange, onError}) {
        this._path = path;
        this._onChange = onChange;
        this._onError = onError;
        this._userId = new Gio.Credentials().get_unix_user();
        this._cancellable = null;
        this._monitor = null;
        this._signalId = 0;
        this._timeoutId = 0;
        this._loading = null;
        this._reloadQueued = false;
        this._lastText = undefined;
    }

    /** Starts watching and resolves once the first load has been reported. */
    async start() {
        this._cancellable = new Gio.Cancellable();
        try {
            this._monitor = Gio.File.new_for_path(this._path).monitor_file(
                Gio.FileMonitorFlags.WATCH_MOVES,
                this._cancellable);
            this._signalId = this._monitor.connect(
                'changed',
                () => this._scheduleReload());
        } catch (error) {
            this._onError?.(`Watching config.json failed: ${error.message}`);
        }
        await this._reload();
    }

    cancel() {
        this._cancellable?.cancel();
        if (this._timeoutId !== 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._signalId !== 0) {
            this._monitor.disconnect(this._signalId);
            this._signalId = 0;
        }
        this._monitor?.cancel();
        this._monitor = null;
        this._onChange = null;
        this._onError = null;
    }

    _scheduleReload() {
        if (this._timeoutId !== 0)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RELOAD_DELAY_MS,
            () => {
                this._timeoutId = 0;
                this._reload().catch(error =>
                    this._onError?.(`Reloading config.json failed: ${error.message}`));
                return GLib.SOURCE_REMOVE;
            });
    }

    async _reload() {
        if (this._loading !== null) {
            this._reloadQueued = true;
            return;
        }
        this._loading = this._load();
        try {
            await this._loading;
        } finally {
            this._loading = null;
        }
        if (this._reloadQueued) {
            this._reloadQueued = false;
            await this._reload();
        }
    }

    async _load() {
        let text;
        let config;
        try {
            text = await this._readText();
            config = text === null ? DEFAULT_CONFIG : parseConfig(text);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._onError?.(error.message);
            return;
        }
        if (this._cancellable.is_cancelled() || text === this._lastText)
            return;
        this._lastText = text;
        this._onChange?.(config);
    }

    async _readText() {
        const file = Gio.File.new_for_path(this._path);
        let info;
        try {
            info = await queryInfo(file, SECURITY_ATTRIBUTES, this._cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw error;
        }
        validateOwnedFile(info, this._userId, false, 'config.json');
        const bytes = await loadBoundedContents(
            file,
            MAX_CONFIG_BYTES,
            this._cancellable,
            'config.json');
        try {
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch (_error) {
            throw new Error('config.json is not valid UTF-8');
        }
    }
}
