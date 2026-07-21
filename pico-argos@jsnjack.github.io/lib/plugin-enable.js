// SPDX-License-Identifier: GPL-3.0-or-later

const MAX_DISABLED_PLUGIN_IDS = 64;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Returns a bounded, unique, ordered disabled-plugin setting value. */
export function normalizeDisabledPluginIds(values) {
    if (!Array.isArray(values))
        return [];
    return [...new Set(values.slice(0, MAX_DISABLED_PLUGIN_IDS)
        .filter(value => typeof value === 'string' &&
            PLUGIN_ID_PATTERN.test(value)))]
        .sort((left, right) => left.localeCompare(right));
}

/** Returns whether one validated discovered plugin should run. */
export function isPluginEnabled(disabledPluginIds, pluginId) {
    return !disabledPluginIds.includes(pluginId);
}

/** Produces the next atomic disabled-plugin setting value. */
export function setPluginEnabled(disabledPluginIds, pluginId, enabled) {
    if (!PLUGIN_ID_PATTERN.test(pluginId))
        throw new Error(`Invalid plugin id: ${pluginId}`);
    const disabled = new Set(normalizeDisabledPluginIds(disabledPluginIds));
    if (enabled)
        disabled.delete(pluginId);
    else
        disabled.add(pluginId);
    return normalizeDisabledPluginIds([...disabled]);
}
