// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    ConfigError,
    configurePlugin,
    DEFAULT_CONFIG,
    isPluginEnabled,
    parseConfig,
    updateConfigText,
} from './config.js';
import {ConfigMonitor} from './config-monitor.js';

function expectConfigError(text, fragment, message) {
    try {
        parseConfig(text);
    } catch (error) {
        if (!(error instanceof ConfigError) || !error.message.includes(fragment))
            throw new Error(`${message}: got ${error.message}`);
        return;
    }
    throw new Error(`${message}: no error`);
}

// An empty or missing file means every default.
const empty = parseConfig('  \n');
if (empty.extension.diagnosticsMode !== 'summary' ||
    empty.extension.explicitPanelRedraw !== true ||
    empty.plugins.size !== 0 ||
    DEFAULT_CONFIG.extension.diagnosticsMode !== 'summary')
    throw new Error('An empty config.json did not produce the defaults');

// Placement keys go to the extension; every other key goes to the plugin.
const full = parseConfig(JSON.stringify({
    extension: {diagnosticsMode: 'off', explicitPanelRedraw: false},
    plugins: {
        'system-monitor': {
            position: 'center',
            order: -3,
            fastIntervalMs: 1_000,
            thresholds: {cpu: {critical: 90}},
        },
        weather: {enabled: false},
    },
}));
const monitor = full.plugins.get('system-monitor');
if (full.extension.diagnosticsMode !== 'off' ||
    full.extension.explicitPanelRedraw !== false ||
    monitor.position !== 'center' || monitor.order !== -3 ||
    monitor.settingsJson !== '{"fastIntervalMs":1000,"thresholds":{"cpu":{"critical":90}}}' ||
    isPluginEnabled(full, 'weather') ||
    !isPluginEnabled(full, 'system-monitor') ||
    !isPluginEnabled(full, 'unlisted'))
    throw new Error(`config.json was not split into extension and plugin values: ${JSON.stringify([...full.plugins])}`);

const discovered = Object.freeze({
    id: 'system-monitor',
    manifest: Object.freeze({id: 'system-monitor', position: 'left', order: 0}),
});
const configured = configurePlugin(discovered, monitor);
const unconfigured = configurePlugin(discovered);
if (configured.manifest.position !== 'center' || configured.manifest.order !== -3 ||
    configured.manifest.settingsJson !== monitor.settingsJson ||
    unconfigured.manifest.position !== 'left' || unconfigured.manifest.order !== 0 ||
    unconfigured.manifest.settingsJson !== '{}' ||
    discovered.manifest.settingsJson !== undefined)
    throw new Error('A plugin entry did not override placement and settings without mutation');

expectConfigError('{"extension": {', 'not valid JSON', 'Malformed JSON was accepted');
expectConfigError('[]', 'must be a JSON object', 'A top-level array was accepted');
expectConfigError('{"plugin": {}}', 'unknown key "plugin"', 'A misspelled top-level key was accepted');
expectConfigError('{"extension": {"diagnostics": "off"}}', 'unknown key "diagnostics"',
    'An unknown extension key was accepted');
expectConfigError('{"extension": {"diagnosticsMode": "loud"}}', 'diagnosticsMode',
    'An invalid diagnostics mode was accepted');
expectConfigError('{"plugins": {"Bad Id": {}}}', 'not a valid plugin id',
    'An invalid plugin id was accepted');
expectConfigError('{"plugins": {"vpn": true}}', 'must be a JSON object',
    'A non-object plugin entry was accepted');
expectConfigError('{"plugins": {"vpn": {"enabled": "no"}}}', 'enabled',
    'A non-boolean enabled was accepted');
expectConfigError('{"plugins": {"vpn": {"position": "top"}}}', 'position',
    'An unknown position was accepted');
expectConfigError('{"plugins": {"vpn": {"order": 1.5}}}', 'order',
    'A fractional order was accepted');

// The preferences change one value and keep every other key in place.
const original = '{"plugins": {"weather": {"location": "auto"}, "vpn": {}}}';
const edited = updateConfigText(original, ['plugins', 'weather', 'enabled'], false);
if (edited !== `${JSON.stringify({
    plugins: {weather: {location: 'auto', enabled: false}, vpn: {}},
}, null, 2)}\n`)
    throw new Error(`Editing one value changed other keys: ${edited}`);
const created = updateConfigText('', ['extension', 'diagnosticsMode'], 'off');
if (parseConfig(created).extension.diagnosticsMode !== 'off')
    throw new Error('Editing an empty config.json did not create the value');
for (const [text, path, value, message] of [
    ['{"extension": ', ['extension', 'diagnosticsMode'], 'off',
        'A malformed file was overwritten'],
    ['{}', ['extension', 'diagnosticsMode'], 'loud',
        'An edit that makes the file invalid was accepted'],
]) {
    let rejected = false;
    try {
        updateConfigText(text, path, value);
    } catch (error) {
        rejected = error instanceof ConfigError;
    }
    if (!rejected)
        throw new Error(message);
}

// The monitor reports defaults for a missing file, then each valid change,
// and keeps the last valid configuration when the file becomes invalid.
const directory = GLib.dir_make_tmp('pico-argos-config-test.XXXXXX');
const path = GLib.build_filenamev([directory, 'config.json']);
const file = Gio.File.new_for_path(path);
const changes = [];
const errors = [];
const configMonitor = new ConfigMonitor({
    path,
    onChange: config => changes.push(config),
    onError: message => errors.push(message),
});

function write(text) {
    file.replace_contents(text, null, false, Gio.FileCreateFlags.PRIVATE, null);
}

async function waitFor(predicate, message) {
    const deadline = GLib.get_monotonic_time() + 5_000_000;
    while (!predicate()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(message);
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }
}

await configMonitor.start();
if (changes.length !== 1 || changes[0] !== DEFAULT_CONFIG)
    throw new Error('A missing config.json did not load as the defaults');
write('{"plugins": {"vpn": {"enabled": false}}}');
await waitFor(() => changes.length === 2, 'A config.json change was not reported');
if (isPluginEnabled(changes[1], 'vpn'))
    throw new Error('The reported configuration did not reflect the file');
write('{"plugins": ');
await waitFor(() => errors.length === 1, 'An invalid config.json was not reported');
if (changes.length !== 2 || !errors[0].includes('not valid JSON'))
    throw new Error(`An invalid config.json replaced the last valid one: ${errors[0]}`);
GLib.chmod(path, 0o666);
write('{}');
await waitFor(() => errors.length === 2, 'A world-writable config.json was not rejected');
if (changes.length !== 2 || !errors[1].includes('group or world writable'))
    throw new Error(`A world-writable config.json was accepted: ${errors[1]}`);
configMonitor.cancel();
file.delete(null);
Gio.File.new_for_path(directory).delete(null);
print('ok - config.json splits extension and plugin values, edits in place, and reloads safely');
