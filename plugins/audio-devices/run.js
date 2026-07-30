#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GObject from 'gi://GObject';
import Wp from 'gi://Wp?version=0.5';
import System from 'system';

import {
    audioSnapshot,
    parseActivation,
    parseAudioConfig,
} from './logic.js';

const DEFAULT_SINK_CLASS = 'Audio/Sink';
const DEFAULT_SOURCE_CLASS = 'Audio/Source';
const HEARTBEAT_SECONDS = 5;
const INPUT_READ_BYTES = 1_024;
const MAX_INPUT_LINE_BYTES = 4_096;
const MAX_ROUTE_DUMP_BYTES = 8 * 1_024 * 1_024;
const STATE_COALESCE_MS = 50;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const stdout = GioUnix.OutputStream.new(1, false);
const stdin = GioUnix.InputStream.new(0, false);
const cancellable = new Gio.Cancellable();
const loop = GLib.MainLoop.new(null, false);

let core = null;
let manager = null;
let defaultNodes = null;
let configuration = null;
let lastSnapshot = null;
let actionTargets = new Map();
let pendingInput = new Uint8Array();
let cardPorts = new Map();
let portRefresh = null;
let portsReported = false;
let stateSourceId = 0;
let stateForce = false;
let heartbeatSourceId = 0;
let fatalError = null;
const signalIds = [];

try {
    configuration = loadConfiguration();
    Wp.init(Wp.InitFlags.PIPEWIRE);
    core = Wp.Core.new(null, null, null);
    await activate(core, Wp.CoreFeatures.CONNECTED);
    await loadComponent(
        core,
        'libwireplumber-module-default-nodes-api',
        'module');
    defaultNodes = Wp.Plugin.find(core, 'default-nodes-api');
    if (defaultNodes === null)
        throw new Error('WirePlumber default-nodes-api is unavailable');
    await activate(defaultNodes, Wp.PluginFeatures.ENABLED);

    manager = Wp.ObjectManager.new();
    manager.add_interest_full(Wp.ObjectInterest.new_type(Wp.Node.$gtype));
    manager.request_object_features(
        Wp.Node.$gtype,
        Wp.ProxyFeatures.PIPEWIRE_OBJECT_FEATURES_MINIMAL);
    await installObjectManager(core, manager);

    connect(manager, 'object-added', () => scheduleSnapshot());
    connect(manager, 'object-removed', () => scheduleSnapshot());
    connect(manager, 'objects-changed', () => scheduleSnapshot());
    connect(defaultNodes, 'changed', () => scheduleSnapshot());
    connect(core, 'disconnected', () => fail(
        new Error('WirePlumber core disconnected')));

    await refreshPorts();
    emitSnapshot(true);
    readInput();
    heartbeatSourceId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        HEARTBEAT_SECONDS,
        () => {
            writeMessage({version: 2, type: 'heartbeat'});
            return GLib.SOURCE_CONTINUE;
        });
    for (const signal of [2, 15]) {
        const sourceId = GLibUnix.signal_add(
            GLib.PRIORITY_DEFAULT,
            signal,
            () => {
                loop.quit();
                return GLib.SOURCE_REMOVE;
            });
        signalIds.push([null, sourceId]);
    }
    loop.run();
} catch (error) {
    fatalError = error;
} finally {
    cancellable.cancel();
    removeSource('stateSourceId');
    removeSource('heartbeatSourceId');
    for (const [object, id] of signalIds) {
        if (object === null) {
            if (GLib.MainContext.default().find_source_by_id(id) !== null)
                GLib.source_remove(id);
        } else if (GObject.signal_handler_is_connected(object, id)) {
            GObject.Object.prototype.disconnect.call(object, id);
        }
    }
    signalIds.length = 0;
    core?.disconnect();
}

if (fatalError !== null) {
    printerr(`[audio-devices] ${fatalError.message}`);
    System.exit(1);
}

function connect(object, signal, callback) {
    const id = GObject.Object.prototype.connect.call(object, signal, callback);
    signalIds.push([object, id]);
}

function emitSnapshot(force = false) {
    const state = collectState();
    const snapshot = audioSnapshot(state, configuration);
    const raw = JSON.stringify(snapshot);
    if (force || raw !== lastSnapshot) {
        writeRaw(raw);
        lastSnapshot = raw;
    }
}

function scheduleSnapshot(force = false) {
    stateForce ||= force;
    if (stateSourceId !== 0)
        return;
    stateSourceId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        STATE_COALESCE_MS,
        () => {
            stateSourceId = 0;
            const shouldForce = stateForce;
            stateForce = false;
            refreshPorts().then(() => {
                if (cancellable.is_cancelled())
                    return;
                emitSnapshot(shouldForce);
            }).catch(error => fail(error));
            return GLib.SOURCE_REMOVE;
        });
}

function collectState() {
    const outputs = [];
    const inputs = [];
    const targets = new Map();
    const iterator = manager.new_iterator();
    iterator.foreach(node => {
        if (!(node instanceof Wp.Node))
            return true;
        const mediaClass = nodeProperty(node, 'media.class');
        if (mediaClass !== DEFAULT_SINK_CLASS &&
            mediaClass !== DEFAULT_SOURCE_CLASS)
            return true;
        const boundId = node.get_bound_id();
        const nodeName = nodeProperty(node, 'node.name');
        if (!Number.isInteger(boundId) ||
            boundId < 0 ||
            boundId >= 4_294_967_295 ||
            nodeName === null)
            return true;
        const id = String(boundId);
        const prefix = mediaClass === DEFAULT_SINK_CLASS ? 'output' : 'input';
        const port = cardPorts.get(portKey(
            nodeProperty(node, 'device.id'),
            nodeProperty(node, 'card.profile.device'),
            prefix === 'output' ? 'Output' : 'Input')) ?? null;
        const device = {
            id,
            nodeName,
            label: firstProperty(node, [
                'node.nick',
                'node.description',
                'device.description',
                'device.nick',
                'node.name',
            ]),
            shortLabel: firstProperty(node, [
                'node.nick',
                'device.profile.description',
                'node.description',
                'node.name',
            ]),
            portLabel: port?.description ?? null,
            portChoices: port?.choices ?? 0,
        };
        const values = prefix === 'output' ? outputs : inputs;
        values.push(device);
        targets.set(`${prefix}:${id}`, {mediaClass, nodeName});
        return true;
    });
    actionTargets = targets;
    return {
        outputs,
        inputs,
        defaultOutputId: defaultNodeId(DEFAULT_SINK_CLASS),
        defaultInputId: defaultNodeId(DEFAULT_SOURCE_CLASS),
    };
}

function defaultNodeId(mediaClass) {
    const id = defaultNodes.emit('get-default-node', mediaClass);
    return Number.isInteger(id) && id < 4_294_967_295 ? String(id) : null;
}

function nodeProperty(node, key) {
    return node.get_properties()?.get(key) ??
        node.get_global_properties()?.get(key) ??
        null;
}

function firstProperty(node, keys) {
    for (const key of keys) {
        const value = nodeProperty(node, key);
        if (typeof value === 'string' && value.trim().length !== 0)
            return value.trim();
    }
    return 'Unknown audio device';
}

/**
 * Refreshes the active port name and port count of every card.
 *
 * WirePlumber publishes these as SPA object pods on the device, and GJS cannot
 * read an object pod's properties: wp_spa_pod_get_property() aborts the
 * process under introspection. `pw-dump` reports the same Route and EnumRoute
 * parameters as plain JSON, so one short-lived child at each coalesced device
 * change replaces the unreadable API. A missing or failing `pw-dump` only
 * costs port naming, never the snapshot.
 */
function refreshPorts() {
    if (portRefresh !== null)
        return portRefresh;
    portRefresh = dumpPorts().then(ports => {
        cardPorts = ports;
    }).catch(error => {
        if (!portsReported && !cancellable.is_cancelled()) {
            portsReported = true;
            printerr(`[audio-devices] Port names unavailable: ${error.message}`);
        }
    }).finally(() => {
        portRefresh = null;
    });
    return portRefresh;
}

function dumpPorts() {
    return new Promise((resolve, reject) => {
        const process = Gio.Subprocess.new(
            ['pw-dump'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        process.communicate_utf8_async(null, cancellable, (source, result) => {
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                if (!source.get_successful())
                    throw new Error('pw-dump exited unsuccessfully');
                if (typeof stdout !== 'string' ||
                    stdout.length > MAX_ROUTE_DUMP_BYTES)
                    throw new Error('pw-dump output is unusable');
                resolve(parsePorts(JSON.parse(stdout)));
            } catch (error) {
                reject(error);
            }
        });
    });
}

/** Collapses one `pw-dump` document to active port names and port counts. */
function parsePorts(objects) {
    const ports = new Map();
    if (!Array.isArray(objects))
        throw new Error('pw-dump output is not an array');
    for (const object of objects) {
        if (object?.type !== 'PipeWire:Interface:Device')
            continue;
        const params = object.info?.params;
        if (params === null || typeof params !== 'object')
            continue;
        for (const route of asArray(params.Route)) {
            if (!Number.isInteger(route?.device) ||
                typeof route.direction !== 'string' ||
                typeof route.description !== 'string')
                continue;
            const key = portKey(object.id, route.device, route.direction);
            ports.set(key, {
                description: route.description,
                choices: ports.get(key)?.choices ?? 0,
            });
        }
        for (const route of asArray(params.EnumRoute)) {
            if (!Array.isArray(route?.devices) ||
                typeof route.direction !== 'string')
                continue;
            for (const device of route.devices) {
                if (!Number.isInteger(device))
                    continue;
                const key = portKey(object.id, device, route.direction);
                const entry = ports.get(key);
                if (entry === undefined)
                    ports.set(key, {description: null, choices: 1});
                else
                    entry.choices++;
            }
        }
    }
    return ports;
}

function portKey(deviceId, cardDevice, direction) {
    return `${deviceId}:${cardDevice}:${direction}`;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function readInput() {
    stdin.read_bytes_async(
        INPUT_READ_BYTES,
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (source, result) => {
            if (cancellable.is_cancelled())
                return;
            try {
                const bytes = source.read_bytes_finish(result);
                const chunk = new Uint8Array(bytes.get_data());
                if (chunk.length === 0) {
                    loop.quit();
                    return;
                }
                acceptInputChunk(chunk);
                readInput();
            } catch (error) {
                if (!cancellable.is_cancelled())
                    fail(error);
            }
        });
}

function acceptInputChunk(chunk) {
    const joined = new Uint8Array(pendingInput.length + chunk.length);
    joined.set(pendingInput);
    joined.set(chunk, pendingInput.length);
    let begin = 0;
    for (let index = 0; index < joined.length; index++) {
        if (joined[index] !== 0x0A)
            continue;
        const length = index - begin;
        if (length > MAX_INPUT_LINE_BYTES)
            throw new Error('Audio activation line exceeds 4096 bytes');
        handleActivation(decoder.decode(joined.slice(begin, index)));
        begin = index + 1;
    }
    pendingInput = joined.slice(begin);
    if (pendingInput.length > MAX_INPUT_LINE_BYTES)
        throw new Error('Audio activation line exceeds 4096 bytes');
}

function handleActivation(raw) {
    let request;
    try {
        request = parseActivation(raw);
    } catch (error) {
        throw new Error(`Rejecting core activation: ${error.message}`);
    }
    const target = actionTargets.get(request.id);
    if (target === undefined) {
        writeMessage({
            version: 2,
            type: 'action-result',
            requestId: request.requestId,
            ok: false,
            message: 'Device is no longer available',
        });
        scheduleSnapshot(true);
        return;
    }
    const changed = defaultNodes.emit(
        'set-default-configured-node-name',
        target.mediaClass,
        target.nodeName);
    writeMessage({
        version: 2,
        type: 'action-result',
        requestId: request.requestId,
        ok: changed,
        message: changed ? null : 'WirePlumber rejected the default device',
    });
    scheduleSnapshot(true);
}

function writeMessage(value) {
    writeRaw(JSON.stringify(value));
}

function writeRaw(raw) {
    stdout.write_all(encoder.encode(`${raw}\n`), cancellable);
}

function activate(object, features) {
    return new Promise((resolve, reject) => {
        object.activate(features, cancellable, (source, result) => {
            try {
                source.activate_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function loadComponent(source, component, type) {
    return new Promise((resolve, reject) => {
        source.load_component(
            component,
            type,
            null,
            null,
            cancellable,
            (object, result) => {
                try {
                    object.load_component_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function installObjectManager(source, objectManager) {
    return new Promise(resolve => {
        if (objectManager.is_installed()) {
            resolve();
            return;
        }
        const id = objectManager.connect('installed', () => {
            objectManager.disconnect(id);
            resolve();
        });
        source.install_object_manager(objectManager);
    });
}

function loadConfiguration() {
    const path = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'pico-argos',
        'audio-devices.json',
    ]);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return parseAudioConfig(undefined);
    const [ok, bytes] = file.load_contents(null);
    if (!ok)
        throw new Error('Reading audio configuration failed');
    const data = new Uint8Array(bytes);
    if (data.length > 64 * 1_024)
        throw new Error('Audio configuration exceeds 64 KiB');
    return parseAudioConfig(JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(data)));
}

function fail(error) {
    fatalError ??= error;
    loop.quit();
}

function removeSource(name) {
    const id = name === 'stateSourceId' ? stateSourceId : heartbeatSourceId;
    if (id === 0)
        return;
    GLib.source_remove(id);
    if (name === 'stateSourceId')
        stateSourceId = 0;
    else
        heartbeatSourceId = 0;
}
