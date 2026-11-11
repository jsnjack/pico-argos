// SPDX-License-Identifier: GPL-3.0-or-later

// Runs each reference plugin's real entry point with one invalid setting in
// PICO_ARGOS_CONFIG. Every case stops during settings validation, before any
// network, D-Bus, or PipeWire access, so the expected message proves the
// plugin reads that variable and nothing else.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const RUN_TIMEOUT_MS = 15_000;
const PLUGIN_ROOT = GLib.build_filenamev([GLib.get_current_dir(), 'plugins']);

const cases = [
    ['dependabot', {repository: 'project'}, {GITHUB_TOKEN: 'test-token'},
        'config.json plugins.dependabot.repository must have owner/name form'],
    ['pull-reviews', {user: 'octocat', repositories: 'example/project'}, {GITHUB_TOKEN: 'test-token'},
        'config.json plugins.pull-reviews.repositories must list'],
    ['vpn', {statusUrl: 'http://status.example/ip'}, {},
        'config.json plugins.vpn.statusUrl must use HTTPS'],
    ['weather', {typo: true}, {},
        'Weather configuration has unknown key typo'],
    ['audio-devices', {maxPanelNameChars: 5}, {},
        'Audio maxPanelNameChars must be from 6 through 48'],
    ['system-monitor', {fields: ['cpu', 'cpu']}, {},
        'fields must contain unique'],
    ['battery-power', {intervalMs: 5}, {},
        'intervalMs must be from 1000 through 30000'],
];

const home = GLib.dir_make_tmp('pico-argos-settings-XXXXXX');
let failures = 0;
try {
    for (const [id, settings, environment, expected] of cases) {
        const name = `${id} reads its settings from PICO_ARGOS_CONFIG`;
        try {
            const result = await runPlugin(id, settings, environment);
            if (result.successful)
                throw new Error('the plugin accepted invalid settings');
            if (!result.stderr.includes(expected))
                throw new Error(`stderr lacks "${expected}": ${result.stderr.trim()}`);
            print(`ok - ${name}`);
        } catch (error) {
            failures++;
            printerr(`not ok - ${name}: ${error.message}`);
        }
    }
} finally {
    // Failing to remove the directory means a plugin wrote below its private home.
    if (GLib.rmdir(home) !== 0) {
        failures++;
        printerr(`not ok - plugins left files in ${home}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} settings source case(s) failed`);

async function runPlugin(id, settings, environment) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_environ([
        `PATH=${GLib.getenv('PATH')}`,
        `HOME=${home}`,
        `XDG_CONFIG_HOME=${home}/config`,
        `XDG_CACHE_HOME=${home}/cache`,
        `XDG_RUNTIME_DIR=${home}/runtime`,
        'PICO_ARGOS_PROTOCOL=1',
        `PICO_ARGOS_PLUGIN_ID=${id}`,
        `PICO_ARGOS_CONFIG=${JSON.stringify(settings)}`,
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ]);
    launcher.set_cwd(GLib.build_filenamev([PLUGIN_ROOT, id]));
    const process = launcher.spawnv(['gjs', '-m', './run.js']);
    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RUN_TIMEOUT_MS, () => {
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [, stderr] = await process.communicate_utf8_async(null, null);
        return {successful: process.get_successful(), stderr: stderr ?? ''};
    } finally {
        if (GLib.MainContext.default().find_source_by_id(timeoutId) !== null)
            GLib.source_remove(timeoutId);
    }
}
