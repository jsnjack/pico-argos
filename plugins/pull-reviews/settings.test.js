// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {
    DEFAULT_ISSUE_REPOSITORY,
    MAX_REPOSITORIES,
    pullReviewsSettings,
    readPullReviewsSettings,
} from './settings.js';

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertRejects(callback, pattern) {
    try {
        callback();
    } catch (error) {
        if (!pattern.test(error.message))
            throw new Error(`Unexpected rejection: ${error.message}`);
        return;
    }
    throw new Error(`Invalid settings were accepted; expected ${pattern}`);
}

function withSettingsVariable(value, callback) {
    const previous = GLib.getenv('PICO_ARGOS_CONFIG');
    if (value === null)
        GLib.unsetenv('PICO_ARGOS_CONFIG');
    else
        GLib.setenv('PICO_ARGOS_CONFIG', value, true);
    try {
        return callback();
    } finally {
        if (previous === null)
            GLib.unsetenv('PICO_ARGOS_CONFIG');
        else
            GLib.setenv('PICO_ARGOS_CONFIG', previous, true);
    }
}

function settings(value) {
    return pullReviewsSettings(JSON.stringify(value));
}

const valid = {user: 'octocat', repositories: ['example/project']};

const cases = [
    ['reads repositories from its settings array', () => {
        const result = withSettingsVariable(JSON.stringify({
            user: 'octocat',
            repositories: ['example/project', 'example/tools'],
        }), readPullReviewsSettings);
        assertEqual(result, {
            user: 'octocat',
            repositories: ['example/project', 'example/tools'],
            issueRepository: DEFAULT_ISSUE_REPOSITORY,
        }, 'settings');
    }],
    ['keeps surfly/it as the default issue repository', () => {
        assertEqual(DEFAULT_ISSUE_REPOSITORY, 'surfly/it', 'default issue repository');
    }],
    ['reads a configured issue repository', () => {
        assertEqual(settings({...valid, issueRepository: 'example/issues'}).issueRepository,
            'example/issues', 'issue repository');
    }],
    ['requires a user when the variable is unset', () => {
        assertRejects(() => withSettingsVariable(null, readPullReviewsSettings),
            /^config\.json plugins\.pull-reviews\.user is required$/);
    }],
    ['requires repositories', () => {
        assertRejects(() => settings({user: 'octocat'}), /repositories is required/);
    }],
    ['rejects the old comma-separated repositories string', () => {
        assertRejects(() => settings({user: 'octocat', repositories: 'example/project,example/tools'}),
            /repositories must list 1 to 20 owner\/name values/);
    }],
    ['rejects empty, oversized, and malformed repository arrays', () => {
        const oversized = Array.from({length: MAX_REPOSITORIES + 1}, (_value, index) => `example/r${index}`);
        for (const repositories of [[], oversized, ['example/project', 5], [' example/project']])
            assertRejects(() => settings({user: 'octocat', repositories}), /repositories must list/);
        const largest = Array.from({length: MAX_REPOSITORIES}, (_value, index) => `example/r${index}`);
        assertEqual(settings({user: 'octocat', repositories: largest}).repositories.length,
            MAX_REPOSITORIES, 'largest repository list');
    }],
    ['rejects an invalid user', () => {
        for (const user of ['octo cat', '', 7])
            assertRejects(() => settings({...valid, user}), /user is invalid/);
    }],
    ['rejects an issue repository without owner/name form', () => {
        assertRejects(() => settings({...valid, issueRepository: 'issues'}),
            /issueRepository must have owner\/name form/);
    }],
    ['rejects unknown settings, including a token', () => {
        assertRejects(() => settings({...valid, token: 'x'}),
            /^Unknown setting config\.json plugins\.pull-reviews\.token$/);
    }],
    ['rejects settings that are not a JSON object', () => {
        assertRejects(() => pullReviewsSettings('{'), /PICO_ARGOS_CONFIG is not valid JSON/);
        for (const raw of ['[]', 'null', '"octocat"'])
            assertRejects(() => pullReviewsSettings(raw), /PICO_ARGOS_CONFIG must be a JSON object/);
    }],
];

let failures = 0;
for (const [name, test] of cases) {
    try {
        test();
        print(`ok - pull-reviews settings ${name}`);
    } catch (error) {
        failures++;
        printerr(`not ok - pull-reviews settings ${name}: ${error.message}`);
    }
}
if (failures !== 0)
    throw new Error(`${failures} pull-reviews settings case(s) failed`);
