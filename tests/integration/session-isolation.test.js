// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const source = Gio.File.new_for_uri(import.meta.url).get_parent()
    .get_child('nested-shell.sh');
const root = GLib.dir_make_tmp('pico-argos-session-test.XXXXXX');

function write(path, text, executable = false) {
    const file = Gio.File.new_for_path(`${root}/${path}`);
    const parent = file.get_parent();
    if (!parent.query_exists(null))
        parent.make_directory_with_parents(null);
    file.replace_contents(text, null, false, Gio.FileCreateFlags.PRIVATE, null);
    if (executable)
        GLib.chmod(file.get_path(), 0o700);
}

function read(path) {
    const [, contents] = GLib.file_get_contents(`${root}/${path}`);
    return new TextDecoder().decode(contents).trim();
}

try {
    const [, contents] = source.load_contents(null);
    write('repo/tests/integration/nested-shell.sh', contents);
    write('repo/tests/performance/build-presentation-client.sh', '#!/bin/bash\nexit 0\n', true);
    const uuid = 'pico-argos@jsnjack.github.io';
    write(`repo/dist/${uuid}.shell-extension.zip`, 'fixture');
    for (const name of ['metadata.json', 'extension.js'])
        write(`repo/tests/integration/actor-harness/${name}`, 'fixture');
    for (const name of ['diagnostics', 'manifest', 'plugin-indicator', 'trace'])
        write(`repo/${uuid}/lib/${name}.js`, 'fixture');
    write(`repo/${uuid}/stylesheet.css`, 'fixture');
    for (const name of ['plugin.json', 'run'])
        write(`repo/tests/fixtures/plugins/smoke/${name}`, 'fixture');
    write('bin/gnome-shell', '#!/bin/bash\necho "GNOME Shell 50.0"\n', true);
    for (const name of ['cc', 'gdbus', 'gjs', 'gnome-extensions', 'jq',
        'pgrep', 'pkg-config', 'rg', 'unzip', 'wayland-scanner'])
        write(`bin/${name}`, '#!/bin/bash\nexit 0\n', true);
    write('bin/dbus-run-session', `#!/bin/bash
set -eu
printf '%s\\n' "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$GSETTINGS_BACKEND" > "$SESSION_TEST_ROOT/environment"
stat -c %a "$XDG_RUNTIME_DIR" > "$SESSION_TEST_ROOT/runtime-mode"
mkdir -p "$XDG_RUNTIME_DIR/doc"
touch "$XDG_RUNTIME_DIR/doc/test-file"
exit "$SESSION_TEST_EXIT"
`, true);
    write('desktop/doc/by-app/com.spotify.Client', 'desktop portal');

    for (const exitStatus of [0, 23]) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv('PATH', `${root}/bin:${GLib.getenv('PATH')}`, true);
        launcher.setenv('TMPDIR', root, true);
        launcher.setenv('SESSION_TEST_ROOT', root, true);
        launcher.setenv('SESSION_TEST_EXIT', `${exitStatus}`, true);
        for (const name of ['XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME',
            'XDG_CACHE_HOME', 'XDG_DATA_HOME'])
            launcher.setenv(name, `${root}/desktop`, true);
        launcher.setenv('GSETTINGS_BACKEND', 'dconf', true);
        const process = launcher.spawnv(['bash', `${root}/repo/tests/integration/nested-shell.sh`]);
        const [, stdout, stderr] = process.communicate_utf8(null, null);
        if (process.get_exit_status() !== exitStatus)
            throw new Error(`Session exit ${exitStatus}: ${stdout}\n${stderr}`);
        const values = read('environment').split('\n');
        const runtime = values[0];
        if (values.length !== 5 || !runtime.startsWith(`${root}/pico-argos-integration.`))
            throw new Error(`Bus inherited the desktop environment: ${values}`);
        const sessionRoot = GLib.path_get_dirname(runtime);
        if (GLib.file_test(sessionRoot, GLib.FileTest.EXISTS))
            throw new Error(`Session files survived exit ${exitStatus}: ${sessionRoot}`);
        if (read('runtime-mode') !== '700')
            throw new Error('Runtime directory is not private');
        for (const [index, name] of ['config', 'cache', 'data'].entries()) {
            if (values[index + 1] !== `${sessionRoot}/${name}`)
                throw new Error(`Bus inherited desktop ${name}: ${values[index + 1]}`);
        }
        if (values[4] !== 'keyfile')
            throw new Error(`Bus inherited desktop GSettings backend: ${values[4]}`);
        if (read('desktop/doc/by-app/com.spotify.Client') !== 'desktop portal')
            throw new Error('Desktop portal changed');
        print(`ok - nested session environment and cleanup on exit ${exitStatus}`);
    }
} finally {
    const cleanup = Gio.Subprocess.new(['rm', '-rf', '--one-file-system', '--', root],
        Gio.SubprocessFlags.NONE);
    cleanup.wait_check(null);
}
