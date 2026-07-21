// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PluginRegistry} from './plugin-registry.js';

const rootPath = GLib.dir_make_tmp('pico-argos-registry-test.XXXXXX');
const root = Gio.File.new_for_path(rootPath);

function createPlugin(id, overrides = {}) {
    const directory = root.get_child(id);
    directory.make_directory(null);
    const executable = directory.get_child('run');
    executable.replace_contents(
        '#!/bin/sh\nexit 0\n',
        null,
        false,
        Gio.FileCreateFlags.PRIVATE,
        null);
    GLib.chmod(executable.get_path(), 0o700);
    const manifest = {
        manifestVersion: 1,
        id,
        mode: 'oneshot',
        command: ['./run'],
        intervalMs: 5_000,
        timeoutMs: 4_000,
        refreshOnOpen: false,
        position: 'right',
        order: 10,
        passEnvironment: [],
        failurePolicy: 'keep-last',
        maxStaleMs: 10_000,
        ...overrides,
    };
    directory.get_child('plugin.json').replace_contents(
        JSON.stringify(manifest),
        null,
        false,
        Gio.FileCreateFlags.PRIVATE,
        null);
    return directory;
}

function deletePlugin(directory) {
    directory.get_child('plugin.json').delete(null);
    directory.get_child('run').delete(null);
    directory.delete(null);
}

const later = createPlugin('later', {order: 20});
const earlier = createPlugin('earlier', {order: 10});
const interpreted = createPlugin('interpreted', {
    command: ['gjs', '-m', './run.js'],
    order: 10,
});
const interpretedSource = interpreted.get_child('run.js');
interpretedSource.replace_contents(
    '#!/usr/bin/env -S gjs -m\n',
    null,
    false,
    Gio.FileCreateFlags.PRIVATE,
    null);
const invalid = createPlugin('invalid', {timeoutMs: 5_000});
const ignored = createPlugin('.editor-temporary', {id: '.editor-temporary'});

const discoveryRegistry = new PluginRegistry(rootPath);
const result = await discoveryRegistry.discover();
if (JSON.stringify(result.plugins.map(plugin => plugin.id)) !==
    JSON.stringify(['earlier', 'interpreted', 'later']))
    throw new Error(`Unexpected discovered plugins: ${JSON.stringify(result.plugins)}`);
if (result.errors.length !== 1 || result.errors[0].id !== 'invalid')
    throw new Error(`Unexpected registry errors: ${JSON.stringify(result.errors)}`);
if (result.plugins[0].manifest.command[0] !== `${rootPath}/earlier/run`)
    throw new Error('Registry did not normalize the executable path');

let resolveReplacement;
const replacementPromise = new Promise(resolve => {
    resolveReplacement = resolve;
});
const monitoringRegistry = new PluginRegistry(rootPath);
await monitoringRegistry.start(event => {
    if (event.kind === 'replaced' && event.plugin.id === 'later')
        resolveReplacement(event);
});
const manifestFile = later.get_child('plugin.json');
const [, manifestContents] = manifestFile.load_contents(null);
const changedManifest = JSON.parse(new TextDecoder().decode(manifestContents));
changedManifest.order = 5;
manifestFile.replace_contents(
    JSON.stringify(changedManifest),
    null,
    false,
    Gio.FileCreateFlags.PRIVATE,
    null);
let timeoutId = 0;
const timeoutPromise = new Promise((_, reject) => {
    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        reject(new Error('Registry replacement monitor timed out'));
        return GLib.SOURCE_REMOVE;
    });
});
const replacement = await Promise.race([replacementPromise, timeoutPromise]);
GLib.source_remove(timeoutId);
if (replacement.plugin.manifest.order !== 5)
    throw new Error('Registry did not validate the replacement manifest');

let resolveExecutableReplacement;
let resolveSourceReplacement;
const executableReplacementPromise = new Promise(resolve => {
    resolveExecutableReplacement = resolve;
});
const sourceReplacementPromise = new Promise(resolve => {
    resolveSourceReplacement = resolve;
});
monitoringRegistry.cancel();
const executableRegistry = new PluginRegistry(rootPath);
await executableRegistry.start(event => {
    if (event.kind === 'replaced' && event.plugin.id === 'earlier')
        resolveExecutableReplacement(event);
    if (event.kind === 'replaced' && event.plugin.id === 'interpreted')
        resolveSourceReplacement(event);
});
const earlierExecutable = earlier.get_child('run');
earlierExecutable.replace_contents(
    '#!/bin/sh\nexit 1\n',
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null);
GLib.chmod(earlierExecutable.get_path(), 0o700);
let executableTimeoutId = 0;
const executableTimeoutPromise = new Promise((_, reject) => {
    executableTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        reject(new Error('Registry executable replacement monitor timed out'));
        return GLib.SOURCE_REMOVE;
    });
});
const executableReplacement = await Promise.race([
    executableReplacementPromise,
    executableTimeoutPromise,
]);
GLib.source_remove(executableTimeoutId);
if (executableReplacement.previous.executableIdentity ===
    executableReplacement.plugin.executableIdentity) {
    throw new Error('Registry did not distinguish executable replacement');
}

interpretedSource.replace_contents(
    '#!/usr/bin/env -S gjs -m\nprint("changed");\n',
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null);
let sourceTimeoutId = 0;
const sourceTimeoutPromise = new Promise((_, reject) => {
    sourceTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        reject(new Error('Registry local command replacement monitor timed out'));
        return GLib.SOURCE_REMOVE;
    });
});
const sourceReplacement = await Promise.race([
    sourceReplacementPromise,
    sourceTimeoutPromise,
]);
GLib.source_remove(sourceTimeoutId);
if (sourceReplacement.previous.localFileIdentity ===
    sourceReplacement.plugin.localFileIdentity) {
    throw new Error('Registry did not distinguish interpreted source replacement');
}
executableRegistry.cancel();

deletePlugin(later);
deletePlugin(earlier);
interpretedSource.delete(null);
deletePlugin(interpreted);
deletePlugin(invalid);
deletePlugin(ignored);
root.delete(null);
print('ok - plugin registry discovers valid owned plugins asynchronously');
