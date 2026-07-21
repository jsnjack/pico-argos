// SPDX-License-Identifier: GPL-3.0-or-later

import {buildPluginEnvironment} from './process-environment.js';

const environment = buildPluginEnvironment({
    id: 'test',
    passEnvironment: [],
});
const names = environment.map(entry => entry.slice(0, entry.indexOf('=')));
for (const required of [
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'PICO_ARGOS_PROTOCOL',
    'PICO_ARGOS_PLUGIN_ID',
]) {
    if (!names.includes(required))
        throw new Error(`Minimal plugin environment omitted ${required}`);
}
if (names.includes('PICO_ARGOS_MENU_OPEN'))
    throw new Error('Stream environment unexpectedly included menu-open state');
if (!environment.includes('PATH=/usr/local/bin:/usr/bin:/bin'))
    throw new Error('Plugin environment inherited a non-minimal executable path');
const reserved = buildPluginEnvironment({id: 'test', passEnvironment: ['PATH']});
if (!reserved.includes('PATH=/usr/local/bin:/usr/bin:/bin'))
    throw new Error('Allowlisted input overrode the runtime fixed environment');
const oneShot = buildPluginEnvironment({id: 'test', passEnvironment: []}, false);
if (!oneShot.includes('PICO_ARGOS_MENU_OPEN=false'))
    throw new Error('One-shot environment omitted menu-open state');
print('ok - child process environment is explicit and mode-specific');
