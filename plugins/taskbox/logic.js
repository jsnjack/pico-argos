// SPDX-License-Identifier: GPL-3.0-or-later

// Pure presentation logic for the Taskbox agenda plugin. The input is the
// versioned document `taskbox agenda` prints; the output is a protocol
// version 1 snapshot. Timed moments arrive as RFC 3339 strings already
// localized by Taskbox, so clock text is sliced from the string rather than
// re-derived through the environment's time zone.

/** A task is "current" from this long before its moment until this long after. */
export const WINDOW_MINUTES = 10;

/** Hard panel budget; must not exceed the manifest's reserveTextChars. */
export const PANEL_TEXT_LIMIT = 32;

const WINDOW_MS = WINDOW_MINUTES * 60_000;
const MENU_TEXT_LIMIT = 512;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Builds the snapshot for one agenda document at one moment.
 *
 * @param {object} agenda - parsed `taskbox agenda` version 1 document
 * @param {number} nowMs - the current moment in epoch milliseconds
 * @returns {object} protocol version 1 snapshot
 */
export function taskboxSnapshot(agenda, nowMs) {
    const today = agenda?.today ?? {};
    const overdue = listOf(today.overdue);
    const timed = listOf(today.timed);
    const untimed = listOf(today.untimed);
    const done = Number.isInteger(today.done) && today.done > 0 ? today.done : 0;

    const current = currentTask([...timed, ...overdue], nowMs);
    const remaining = overdue.length + timed.length + untimed.length;

    return {
        version: 1,
        type: 'snapshot',
        panel: panelState({current, remaining, overdue: overdue.length}),
        menu: menuRows({overdue, timed, untimed, done}),
    };
}

/** Keeps only rows that carry the fields the presentation reads. */
function listOf(section) {
    if (!Array.isArray(section))
        return [];
    return section.filter(t => t && typeof t.key === 'string' &&
        typeof t.title === 'string' && t.title !== '');
}

/**
 * Picks the task whose moment the clock is inside of: due no more than
 * WINDOW_MINUTES away in either direction. Ties go to the nearest moment, so
 * during an overlap the panel shows what needs attention most.
 */
function currentTask(tasks, nowMs) {
    let best = null;
    let bestDistance = Infinity;
    for (const task of tasks) {
        if (typeof task.due_at !== 'string')
            continue;
        const dueMs = Date.parse(task.due_at);
        if (!Number.isFinite(dueMs))
            continue;
        const distance = Math.abs(dueMs - nowMs);
        if (distance <= WINDOW_MS && distance < bestDistance) {
            best = task;
            bestDistance = distance;
        }
    }
    return best;
}

/** The panel: the current task, else the day's remaining count, else all clear. */
function panelState({current, remaining, overdue}) {
    if (current !== null) {
        return {
            icon: 'alarm-symbolic',
            text: clampText(`${clockText(current.due_at)} ${current.title}`,
                PANEL_TEXT_LIMIT),
            appearance: 'accent',
            severity: 'normal',
            accessibleName:
                `Current task: ${current.title}, ${clockText(current.due_at)}`,
        };
    }
    if (remaining > 0) {
        return {
            icon: 'checkbox-symbolic',
            text: String(remaining),
            appearance: 'normal',
            severity: overdue > 0 ? 'warning' : 'normal',
            accessibleName: overdue > 0
                ? `${remaining} tasks today, ${overdue} overdue`
                : `${remaining} tasks today`,
        };
    }
    return {
        icon: 'checkbox-checked-symbolic',
        appearance: 'normal',
        severity: 'normal',
        accessibleName: 'Nothing due today',
    };
}

/** The menu: overdue first, then the day in time order, then what is done. */
function menuRows({overdue, timed, untimed, done}) {
    const rows = [];
    if (overdue.length > 0) {
        rows.push({id: 'overdue-heading', kind: 'label', text: 'Overdue'});
        for (const task of overdue)
            rows.push(taskRow(task, overdueDetail(task)));
    }
    if (timed.length > 0 || untimed.length > 0) {
        if (rows.length > 0)
            rows.push({id: 'today-separator', kind: 'separator'});
        rows.push({id: 'today-heading', kind: 'label', text: 'Today'});
        for (const task of timed)
            rows.push(taskRow(task, clockText(task.due_at)));
        for (const task of untimed)
            rows.push(taskRow(task, ''));
    }
    if (rows.length === 0)
        rows.push({id: 'all-clear', kind: 'label', text: 'Nothing due today'});
    if (done > 0) {
        rows.push({id: 'done-separator', kind: 'separator'});
        rows.push({
            id: 'done-count',
            kind: 'label',
            text: done === 1 ? '1 task done today' : `${done} tasks done today`,
        });
    }
    return rows;
}

/** One task row: "detail · title", with a recurrence mark where it applies. */
function taskRow(task, detail) {
    const mark = task.recurring === true ? ' ↻' : '';
    const text = detail === ''
        ? `${task.title}${mark}`
        : `${detail} · ${task.title}${mark}`;
    return {
        id: `task:${task.key}`,
        kind: 'label',
        text: clampText(text, MENU_TEXT_LIMIT),
    };
}

/** What an overdue row leads with: its slipped time today, or its day. */
function overdueDetail(task) {
    if (typeof task.due_at === 'string' && dayOf(task.due_at) === task.date)
        return clockText(task.due_at);
    return dateText(task.date);
}

/** HH:MM sliced from an RFC 3339 moment Taskbox already localized. */
function clockText(dueAt) {
    return typeof dueAt === 'string' && dueAt.length >= 16
        ? dueAt.slice(11, 16)
        : '';
}

/** The YYYY-MM-DD day part of an RFC 3339 moment. */
function dayOf(dueAt) {
    return typeof dueAt === 'string' ? dueAt.slice(0, 10) : '';
}

/** "1 Sep" from "2026-09-01"; the raw value when it is not a date. */
function dateText(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return typeof date === 'string' ? date : '';
    const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? '';
    return `${Number(date.slice(8, 10))} ${month}`;
}

/** Truncates to a Unicode-scalar budget with an ellipsis. */
function clampText(text, limit) {
    const scalars = Array.from(text);
    if (scalars.length <= limit)
        return text;
    return `${scalars.slice(0, limit - 1).join('')}…`;
}
