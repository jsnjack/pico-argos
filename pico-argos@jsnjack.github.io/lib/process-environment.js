// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

const MINIMAL_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Builds the version 1 minimal environment for one plugin child. */
export function buildPluginEnvironment(manifest, menuOpen = null) {
    const values = new Map([
        ['HOME', GLib.get_home_dir()],
        ['PATH', MINIMAL_PATH],
        ['LANG', GLib.getenv('LANG') ?? 'C.UTF-8'],
        ['LC_ALL', GLib.getenv('LC_ALL') ?? ''],
        ['XDG_CONFIG_HOME', GLib.get_user_config_dir()],
        ['XDG_CACHE_HOME', GLib.get_user_cache_dir()],
        ['XDG_DATA_HOME', GLib.get_user_data_dir()],
        ['XDG_STATE_HOME', GLib.getenv('XDG_STATE_HOME') ?? GLib.build_filenamev([
            GLib.get_home_dir(),
            '.local',
            'state',
        ])],
        ['XDG_RUNTIME_DIR', GLib.get_user_runtime_dir() ?? ''],
        ['PICO_ARGOS_PROTOCOL', '1'],
        ['PICO_ARGOS_PLUGIN_ID', manifest.id],
    ]);
    if (menuOpen !== null)
        values.set('PICO_ARGOS_MENU_OPEN', menuOpen ? 'true' : 'false');
    for (const name of manifest.passEnvironment) {
        const value = GLib.getenv(name);
        if (value !== null && !values.has(name))
            values.set(name, value);
    }
    return [...values].map(([name, value]) => `${name}=${value}`);
}
