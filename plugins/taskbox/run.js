#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later

// One bounded snapshot of the Taskbox agenda. The data source is the local
// `taskbox agenda` command, which reads Taskbox's SQLite copy of the account:
// it answers offline and always agrees with the Taskbox window. This plugin
// never talks to Todoist and holds no credential.

import Gio from 'gi://Gio';
import System from 'system';

import {taskboxSnapshot} from './logic.js';

const MAX_AGENDA_BYTES = 65_536;
const AGENDA_VERSION = 1;

try {
    const agenda = await readAgenda();
    print(JSON.stringify(taskboxSnapshot(agenda, Date.now())));
} catch (error) {
    printerr(`[taskbox] ${error.message}`);
    System.exit(1);
}

/**
 * Runs `taskbox agenda` and parses its versioned document. The manifest
 * timeout bounds a hung child; output is bounded here.
 */
function readAgenda() {
    return new Promise((resolve, reject) => {
        let process;
        try {
            process = Gio.Subprocess.new(
                ['taskbox', 'agenda'],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            reject(new Error(`taskbox is not installed: ${error.message}`));
            return;
        }
        process.communicate_utf8_async(null, null, (source, result) => {
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) {
                    const detail = firstLine(stderr);
                    throw new Error(detail === ''
                        ? 'taskbox agenda exited unsuccessfully'
                        : `taskbox agenda failed: ${detail}`);
                }
                if (typeof stdout !== 'string' ||
                    stdout.length > MAX_AGENDA_BYTES)
                    throw new Error('taskbox agenda output is unusable');
                const agenda = JSON.parse(stdout);
                if (agenda?.version !== AGENDA_VERSION)
                    throw new Error(
                        `unsupported agenda version ${agenda?.version}`);
                resolve(agenda);
            } catch (error) {
                reject(error);
            }
        });
    });
}

/** The first non-empty stderr line, bounded, for a one-line diagnosis. */
function firstLine(stderr) {
    if (typeof stderr !== 'string')
        return '';
    const line = stderr.split('\n').find(l => l.trim() !== '') ?? '';
    return line.trim().slice(0, 200);
}
