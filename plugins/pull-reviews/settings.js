// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

// pico-argos passes the plugin's object from config.json in this variable.
const SETTINGS_VARIABLE = 'PICO_ARGOS_CONFIG';
const SETTINGS_PATH = 'config.json plugins.pull-reviews';

/** Receives the Assigned and New issues links when no repository is set. */
export const DEFAULT_ISSUE_REPOSITORY = 'surfly/it';

/** The most repositories the `repositories` array may list. */
export const MAX_REPOSITORIES = 20;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USER_PATTERN = /^[A-Za-z0-9-]+$/;
const KEYS = new Set(['user', 'repositories', 'issueRepository']);

/** Reads and validates the plugin's settings from the environment. */
export function readPullReviewsSettings() {
    return pullReviewsSettings(GLib.getenv(SETTINGS_VARIABLE));
}

/**
 * Strictly validates one settings document, or null when the variable is
 * unset. `user` and `repositories` are required; `issueRepository` defaults
 * to the legacy issue tracker.
 */
export function pullReviewsSettings(raw) {
    const value = parseSettings(raw);
    const unknown = Object.keys(value).find(key => !KEYS.has(key));
    if (unknown !== undefined)
        throw new Error(`Unknown setting ${SETTINGS_PATH}.${unknown}`);
    if (value.user === undefined)
        throw new Error(`${SETTINGS_PATH}.user is required`);
    if (typeof value.user !== 'string' || !USER_PATTERN.test(value.user))
        throw new Error(`${SETTINGS_PATH}.user is invalid`);
    const repositories = value.repositories;
    if (repositories === undefined)
        throw new Error(`${SETTINGS_PATH}.repositories is required`);
    if (!Array.isArray(repositories) || repositories.length === 0 ||
        repositories.length > MAX_REPOSITORIES ||
        repositories.some(repository => typeof repository !== 'string' ||
            !REPOSITORY_PATTERN.test(repository))) {
        throw new Error(`${SETTINGS_PATH}.repositories must list 1 to ` +
            `${MAX_REPOSITORIES} owner/name values`);
    }
    const issueRepository = value.issueRepository ?? DEFAULT_ISSUE_REPOSITORY;
    if (typeof issueRepository !== 'string' ||
        !REPOSITORY_PATTERN.test(issueRepository))
        throw new Error(`${SETTINGS_PATH}.issueRepository must have owner/name form`);
    return Object.freeze({
        user: value.user,
        repositories: Object.freeze([...repositories]),
        issueRepository,
    });
}

function parseSettings(raw) {
    if (raw === null)
        return {};
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${SETTINGS_VARIABLE} is not valid JSON: ${error.message}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${SETTINGS_VARIABLE} must be a JSON object`);
    return value;
}
