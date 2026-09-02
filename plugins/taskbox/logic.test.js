// SPDX-License-Identifier: GPL-3.0-or-later

import {taskboxSnapshot, PANEL_TEXT_LIMIT, WINDOW_MINUTES} from './logic.js';

const T = iso => Date.parse(iso);

const agenda = {
    version: 1,
    today: {
        overdue: [
            {key: 'k-late-time', title: 'Morning call',
                date: '2026-09-02', due_at: '2026-09-02T09:00:00+02:00'},
            {key: 'k-late-day', title: 'Old errand', date: '2026-08-30'},
        ],
        timed: [
            {key: 'k-standup', title: 'Standup',
                date: '2026-09-02', due_at: '2026-09-02T10:00:00+02:00',
                recurring: true},
            {key: 'k-review', title: 'Review',
                date: '2026-09-02', due_at: '2026-09-02T15:00:00+02:00'},
        ],
        untimed: [
            {key: 'k-stamps', title: 'Buy stamps', date: '2026-09-02'},
        ],
        done: 2,
    },
};

// Ten minutes before its moment a task takes over the panel, accent-colored,
// with its clock exactly as Taskbox localized it.
const before = taskboxSnapshot(agenda, T('2026-09-02T09:51:00+02:00'));
if (before.panel.text !== '10:00 Standup' ||
    before.panel.icon !== 'alarm-symbolic' ||
    before.panel.appearance !== 'accent' ||
    before.panel.severity !== 'normal' ||
    !before.panel.accessibleName.includes('Standup'))
    throw new Error(`Be-ready window failed: ${JSON.stringify(before.panel)}`);

// Ten minutes in, the task is still current; a minute later it is not.
const during = taskboxSnapshot(agenda, T('2026-09-02T10:09:00+02:00'));
if (during.panel.text !== '10:00 Standup')
    throw new Error(`In-task window failed: ${JSON.stringify(during.panel)}`);
const after = taskboxSnapshot(agenda, T('2026-09-02T10:11:00+02:00'));
if (after.panel.text === '10:00 Standup')
    throw new Error('The window did not close after ' +
        `${WINDOW_MINUTES} minutes`);

// An overdue timed task can be current too: five minutes past the morning
// call, at 09:05, the call is nearer than the standup.
const overdueCurrent = taskboxSnapshot(agenda, T('2026-09-02T09:05:00+02:00'));
if (overdueCurrent.panel.text !== '09:00 Morning call')
    throw new Error(
        `Overdue current failed: ${JSON.stringify(overdueCurrent.panel)}`);

// Outside every window, the panel counts what remains and warns about the
// overdue pile.
const counting = taskboxSnapshot(agenda, T('2026-09-02T12:00:00+02:00'));
if (counting.panel.text !== '5' ||
    counting.panel.icon !== 'checkbox-symbolic' ||
    counting.panel.severity !== 'warning' ||
    counting.panel.accessibleName !== '5 tasks today, 2 overdue')
    throw new Error(`Count state failed: ${JSON.stringify(counting.panel)}`);

// The menu lists overdue with when it slipped, the day in time order with a
// recurrence mark, and what is already done — every row under a stable ID.
const ids = counting.menu.map(row => row.id);
const expected = [
    'overdue-heading', 'task:k-late-time', 'task:k-late-day',
    'today-separator', 'today-heading',
    'task:k-standup', 'task:k-review', 'task:k-stamps',
    'done-separator', 'done-count',
];
if (JSON.stringify(ids) !== JSON.stringify(expected))
    throw new Error(`Menu order failed: ${JSON.stringify(ids)}`);
const byId = new Map(counting.menu.map(row => [row.id, row]));
if (byId.get('task:k-late-time').text !== '09:00 · Morning call' ||
    byId.get('task:k-late-day').text !== '30 Aug · Old errand' ||
    byId.get('task:k-standup').text !== '10:00 · Standup ↻' ||
    byId.get('task:k-stamps').text !== 'Buy stamps' ||
    byId.get('done-count').text !== '2 tasks done today')
    throw new Error(`Menu rows failed: ${JSON.stringify(counting.menu)}`);

// A clean day: no warning, a checked box with no digits, and an all-clear row.
const clear = taskboxSnapshot(
    {version: 1, today: {overdue: [], timed: [], untimed: [], done: 0}},
    T('2026-09-02T12:00:00+02:00'));
if (clear.panel.text !== undefined ||
    clear.panel.icon !== 'checkbox-checked-symbolic' ||
    clear.panel.severity !== 'normal' ||
    clear.panel.accessibleName !== 'Nothing due today' ||
    clear.menu[0].id !== 'all-clear')
    throw new Error(`All-clear state failed: ${JSON.stringify(clear)}`);

// A no-overdue day counts without warning.
const calm = taskboxSnapshot(
    {version: 1, today: {overdue: [], timed: [
        {key: 'k', title: 'One thing', date: '2026-09-02',
            due_at: '2026-09-02T15:00:00+02:00'},
    ], untimed: [], done: 0}},
    T('2026-09-02T12:00:00+02:00'));
if (calm.panel.severity !== 'normal' || calm.panel.text !== '1')
    throw new Error(`Calm count failed: ${JSON.stringify(calm.panel)}`);

// A long title stays inside the panel budget, counted in Unicode scalars.
const long = taskboxSnapshot(
    {version: 1, today: {overdue: [], timed: [
        {key: 'k', title: '📚'.repeat(60), date: '2026-09-02',
            due_at: '2026-09-02T15:00:00+02:00'},
    ], untimed: [], done: 0}},
    T('2026-09-02T14:55:00+02:00'));
if (Array.from(long.panel.text).length > PANEL_TEXT_LIMIT ||
    !long.panel.text.endsWith('…'))
    throw new Error(`Panel truncation failed: ${JSON.stringify(long.panel)}`);

// Malformed input never throws: it renders as an empty day.
const malformed = taskboxSnapshot({version: 1, today: {
    overdue: 'no', timed: [{title: 7}], untimed: null,
}}, T('2026-09-02T12:00:00+02:00'));
if (malformed.panel.icon !== 'checkbox-checked-symbolic')
    throw new Error(`Malformed input failed: ${JSON.stringify(malformed)}`);

print('ok - taskbox presents the current task window, the day count, and the agenda menu');
