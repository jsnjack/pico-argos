// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {compareManifests, parseManifest} from './manifest.js';

/** Maximum number of accepted plugins. */
export const MAX_PLUGINS = 16;

const MAX_DIRECTORY_CANDIDATES = 64;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const MANIFEST_READ_BYTES = 8 * 1_024;
const DEBOUNCE_MS = 250;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENUMERATION_ATTRIBUTES = [
    Gio.FILE_ATTRIBUTE_STANDARD_NAME,
    Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
].join(',');
const SECURITY_ATTRIBUTES = [
    Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
    Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
    Gio.FILE_ATTRIBUTE_UNIX_UID,
    Gio.FILE_ATTRIBUTE_UNIX_MODE,
    Gio.FILE_ATTRIBUTE_UNIX_INODE,
    Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
    Gio.FILE_ATTRIBUTE_TIME_MODIFIED_USEC,
    Gio.FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE,
].join(',');

/** Discovers and validates plugin directories without synchronous file I/O. */
export class PluginRegistry {
    constructor(rootDirectory = null, cancellable = null) {
        const rootPath = rootDirectory ?? GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'pico-argos',
            'plugins',
        ]);
        this.root = Gio.File.new_for_path(rootPath);
        this._cancellable = cancellable ?? new Gio.Cancellable();
        this._userId = new Gio.Credentials().get_unix_user();
        this._known = new Map();
        this._monitors = new Map();
        this._monitorSignals = new Map();
        this._fileMonitors = new Map();
        this._debounceSources = new Map();
        this._reloadTokens = new Map();
        this._rootMonitor = null;
        this._rootSignalId = 0;
        this._onChange = null;
    }

    /** Returns ordered valid plugins and bounded validation errors. */
    async discover() {
        let candidates;
        try {
            const rootInfo = await queryInfo(
                this.root, SECURITY_ATTRIBUTES, this._cancellable);
            validateOwnedFile(rootInfo, this._userId, true, 'Plugin root directory');
            candidates = await enumerateDirectories(this.root, this._cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {plugins: [], errors: []};
            throw new Error(`Enumerating plugin root ${this.root.get_path()}: ${error.message}`);
        }

        const plugins = [];
        const errors = [];
        for (const candidate of candidates.sort((left, right) =>
            left.name.localeCompare(right.name))) {
            if (!PLUGIN_ID_PATTERN.test(candidate.name))
                continue;
            if (plugins.length === MAX_PLUGINS) {
                errors.push({id: candidate.name, message: `Plugin limit ${MAX_PLUGINS} reached`});
                continue;
            }
            try {
                const plugin = await this._loadPlugin(candidate);
                plugins.push(plugin);
            } catch (error) {
                errors.push({id: candidate.name, message: error.message});
            }
        }
        plugins.sort((left, right) => compareManifests(left.manifest, right.manifest));
        return {plugins, errors};
    }

    /** Discovers initial state and monitors bounded affected plugin paths. */
    async start(onChange) {
        if (this._onChange !== null)
            throw new Error('Plugin registry is already started');
        this._onChange = onChange;
        await ensureDirectoryPath(this.root, this._cancellable);
        const result = await this.discover();
        this._known = new Map(result.plugins.map(plugin => [plugin.id, plugin]));
        this._onChange({kind: 'initial', ...result});

        this._rootMonitor = this.root.monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES,
            this._cancellable);
        this._rootSignalId = this._rootMonitor.connect(
            'changed',
            (_monitor, file, otherFile) => {
                this._scheduleFromRoot(file);
                if (otherFile !== null)
                    this._scheduleFromRoot(otherFile);
            });
        const candidates = await enumerateDirectories(this.root, this._cancellable);
        const candidateIds = new Set();
        for (const candidate of candidates) {
            if (PLUGIN_ID_PATTERN.test(candidate.name)) {
                candidateIds.add(candidate.name);
                this._monitorPlugin(candidate.name);
                if (!this._known.has(candidate.name))
                    this._scheduleReload(candidate.name);
            }
        }
        for (const id of this._known.keys()) {
            if (!candidateIds.has(id))
                this._scheduleReload(id);
        }
    }

    /** Cancels discovery operations owned by this registry. */
    cancel() {
        this._cancellable.cancel();
        if (this._rootSignalId !== 0) {
            this._rootMonitor.disconnect(this._rootSignalId);
            this._rootSignalId = 0;
        }
        this._rootMonitor?.cancel();
        this._rootMonitor = null;
        for (const [id, monitor] of this._monitors) {
            monitor.disconnect(this._monitorSignals.get(id));
            monitor.cancel();
        }
        this._monitors.clear();
        this._monitorSignals.clear();
        for (const monitors of this._fileMonitors.values()) {
            for (const {monitor, signalId} of monitors) {
                monitor.disconnect(signalId);
                monitor.cancel();
            }
        }
        this._fileMonitors.clear();
        for (const sourceId of this._debounceSources.values())
            GLib.source_remove(sourceId);
        this._debounceSources.clear();
        this._reloadTokens.clear();
        this._known.clear();
        this._onChange = null;
    }

    async _loadPlugin(candidate) {
        const directory = this.root.get_child(candidate.name);
        const directoryInfo = await queryInfo(directory, SECURITY_ATTRIBUTES, this._cancellable);
        validateOwnedFile(directoryInfo, this._userId, true, `Plugin ${candidate.name} directory`);

        const manifestFile = directory.get_child('plugin.json');
        const manifestInfo = await queryInfo(manifestFile, SECURITY_ATTRIBUTES, this._cancellable);
        validateOwnedFile(manifestInfo, this._userId, false, `Plugin ${candidate.name} manifest`);
        if (manifestInfo.get_size() > MAX_MANIFEST_BYTES)
            throw new Error(`Plugin ${candidate.name} manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);

        const contents = await loadBoundedContents(
            manifestFile,
            MAX_MANIFEST_BYTES,
            this._cancellable);
        let raw;
        try {
            raw = new TextDecoder('utf-8', {fatal: true}).decode(contents);
        } catch (error) {
            throw new Error(`Plugin ${candidate.name} manifest is not valid UTF-8: ${error.message}`);
        }
        const manifest = parseManifest(raw, directory.get_path(), candidate.name);

        let executableIdentity = null;
        const watchedFiles = [];
        const localFileIdentities = [];
        if (manifest.command[0].includes('/')) {
            const executable = Gio.File.new_for_path(manifest.command[0]);
            const executableInfo = await queryInfo(
                executable, SECURITY_ATTRIBUTES, this._cancellable);
            validateOwnedFile(
                executableInfo, this._userId, false, `Plugin ${candidate.name} executable`);
            if (!executableInfo.get_attribute_boolean(Gio.FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE))
                throw new Error(`Plugin ${candidate.name} executable is not executable`);
            executableIdentity = fileIdentity(executableInfo);
            watchedFiles.push(manifest.command[0]);
        }
        for (const argument of manifest.command.slice(1)) {
            if (!argument.startsWith('./'))
                continue;
            const path = GLib.canonicalize_filename(argument, directory.get_path());
            if (!path.startsWith(`${directory.get_path()}/`))
                continue;
            let info;
            try {
                info = await queryInfo(
                    Gio.File.new_for_path(path), SECURITY_ATTRIBUTES, this._cancellable);
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    continue;
                throw error;
            }
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            validateOwnedFile(
                info, this._userId, false, `Plugin ${candidate.name} local command file`);
            const relative = path.slice(directory.get_path().length + 1);
            localFileIdentities.push(`${relative}:${fileIdentity(info)}`);
            watchedFiles.push(path);
        }

        return Object.freeze({
            id: candidate.name,
            directory: directory.get_path(),
            manifest,
            executableIdentity,
            localFileIdentity: localFileIdentities.sort().join('|'),
            watchedFiles: Object.freeze([...new Set(watchedFiles)]),
        });
    }

    _scheduleFromRoot(file) {
        const id = file.get_basename();
        if (PLUGIN_ID_PATTERN.test(id)) {
            this._unmonitorPlugin(id);
            this._monitorPlugin(id);
            this._scheduleReload(id);
        }
    }

    _monitorPlugin(id) {
        if (!this._monitors.has(id)) {
            try {
                const monitor = this.root.get_child(id).monitor_directory(
                    Gio.FileMonitorFlags.WATCH_MOVES,
                    this._cancellable);
                const signalId = monitor.connect(
                    'changed',
                    (_monitor, file, otherFile) => {
                        const names = [file?.get_basename(), otherFile?.get_basename()];
                        if (names.includes('plugin.json'))
                            this._scheduleReload(id);
                    });
                this._monitors.set(id, monitor);
                this._monitorSignals.set(id, signalId);
            } catch (_error) {
                // A root monitor event will retry after an atomic directory move.
            }
        }
        this._monitorPluginFiles(id);
    }

    _monitorPluginFiles(id) {
        this._unmonitorPluginFiles(id);
        const monitors = [];
        for (const path of this._known.get(id)?.watchedFiles ?? []) {
            try {
                const monitor = Gio.File.new_for_path(path).monitor_file(
                    Gio.FileMonitorFlags.WATCH_MOVES,
                    this._cancellable);
                const signalId = monitor.connect(
                    'changed',
                    () => this._scheduleReload(id));
                monitors.push({monitor, signalId});
            } catch (_error) {
                // Manifest revalidation reports a missing or invalid command file.
            }
        }
        if (monitors.length > 0)
            this._fileMonitors.set(id, monitors);
    }

    _unmonitorPlugin(id) {
        this._unmonitorPluginFiles(id);
        const monitor = this._monitors.get(id);
        if (monitor === undefined)
            return;
        monitor.disconnect(this._monitorSignals.get(id));
        monitor.cancel();
        this._monitors.delete(id);
        this._monitorSignals.delete(id);
    }

    _unmonitorPluginFiles(id) {
        const monitors = this._fileMonitors.get(id);
        if (monitors === undefined)
            return;
        for (const {monitor, signalId} of monitors) {
            monitor.disconnect(signalId);
            monitor.cancel();
        }
        this._fileMonitors.delete(id);
    }

    _scheduleReload(id) {
        const existingSource = this._debounceSources.get(id);
        if (existingSource !== undefined)
            GLib.source_remove(existingSource);

        const sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DEBOUNCE_MS,
            () => {
                this._debounceSources.delete(id);
                this._reload(id).catch(error => {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._onChange?.({kind: 'error', id, message: error.message});
                });
                return GLib.SOURCE_REMOVE;
            });
        this._debounceSources.set(id, sourceId);
    }

    async _reload(id) {
        const token = (this._reloadTokens.get(id) ?? 0) + 1;
        this._reloadTokens.set(id, token);
        let plugin;
        try {
            plugin = await this._loadPlugin({name: id});
        } catch (error) {
            if (token !== this._reloadTokens.get(id))
                return;
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                const previous = this._known.get(id);
                if (previous !== undefined) {
                    this._known.delete(id);
                    this._unmonitorPlugin(id);
                    this._onChange?.({kind: 'removed', id, previous});
                }
                return;
            }
            this._onChange?.({
                kind: 'error',
                id,
                message: error.message,
                retained: this._known.get(id) ?? null,
            });
            return;
        }

        if (token !== this._reloadTokens.get(id))
            return;
        const previous = this._known.get(id) ?? null;
        if (previous === null && this._known.size >= MAX_PLUGINS) {
            this._onChange?.({kind: 'error', id, message: `Plugin limit ${MAX_PLUGINS} reached`});
            return;
        }
        if (previous !== null &&
            JSON.stringify(previous.manifest) === JSON.stringify(plugin.manifest) &&
            previous.executableIdentity === plugin.executableIdentity &&
            previous.localFileIdentity === plugin.localFileIdentity) {
            return;
        }

        this._known.set(id, plugin);
        this._monitorPlugin(id);
        this._onChange?.({kind: previous === null ? 'added' : 'replaced', plugin, previous});
    }
}

async function ensureDirectoryPath(directory, cancellable) {
    const parent = directory.get_parent();
    if (parent !== null)
        await ensureDirectoryPath(parent, cancellable);
    try {
        await makeDirectory(directory, cancellable);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
}

function makeDirectory(directory, cancellable) {
    return new Promise((resolve, reject) => {
        directory.make_directory_async(
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    source.make_directory_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

async function enumerateDirectories(root, cancellable) {
    const enumerator = await new Promise((resolve, reject) => {
        root.enumerate_children_async(
            ENUMERATION_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    resolve(source.enumerate_children_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });

    const candidates = [];
    try {
        for (;;) {
            const infos = await nextFiles(enumerator, 16, cancellable);
            if (infos.length === 0)
                break;
            for (const info of infos) {
                if (candidates.length === MAX_DIRECTORY_CANDIDATES)
                    throw new Error(`Plugin directory exceeds ${MAX_DIRECTORY_CANDIDATES} candidates`);
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    candidates.push({name: info.get_name()});
            }
        }
    } finally {
        await closeEnumerator(enumerator);
    }
    return candidates;
}

function nextFiles(enumerator, count, cancellable) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(
            count,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    resolve(source.next_files_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function closeEnumerator(enumerator) {
    return new Promise(resolve => {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                source.close_finish(result);
            } catch (_error) {
                // The discovery error remains more useful than a close error.
            }
            resolve();
        });
    });
}

function queryInfo(file, attributes, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async(
            attributes,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    resolve(source.query_info_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

async function loadBoundedContents(file, maximumBytes, cancellable) {
    const stream = await openFile(file, cancellable);
    const chunks = [];
    let totalBytes = 0;
    try {
        for (;;) {
            const remainingProbeBytes = maximumBytes + 1 - totalBytes;
            if (remainingProbeBytes === 0)
                throw new Error(`Manifest exceeds ${maximumBytes} bytes`);
            const chunk = await readBytes(
                stream,
                Math.min(MANIFEST_READ_BYTES, remainingProbeBytes),
                cancellable);
            if (chunk.length === 0)
                break;
            chunks.push(chunk);
            totalBytes += chunk.length;
            if (totalBytes > maximumBytes)
                throw new Error(`Manifest exceeds ${maximumBytes} bytes`);
        }
    } finally {
        await closeStream(stream);
    }

    const contents = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        contents.set(chunk, offset);
        offset += chunk.length;
    }
    return contents;
}

function openFile(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                resolve(source.read_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readBytes(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(
            count,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result);
                    resolve(new Uint8Array(bytes.get_data()));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function closeStream(stream) {
    return new Promise(resolve => {
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                source.close_finish(result);
            } catch (_error) {
                // Preserve the read or validation result when closing fails.
            }
            resolve();
        });
    });
}

function validateOwnedFile(info, userId, directory, context) {
    const expectedType = directory ? Gio.FileType.DIRECTORY : Gio.FileType.REGULAR;
    if (info.get_file_type() !== expectedType)
        throw new Error(`${context} has the wrong file type`);
    if (info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_UID) !== userId)
        throw new Error(`${context} is not owned by the current user`);
    const mode = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE);
    if ((mode & 0o022) !== 0)
        throw new Error(`${context} is group or world writable`);
}

function fileIdentity(info) {
    return [
        info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_UNIX_INODE),
        info.get_size(),
        info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED),
        info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_TIME_MODIFIED_USEC),
    ].join(':');
}
