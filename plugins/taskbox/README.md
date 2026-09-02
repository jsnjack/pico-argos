# Taskbox agenda plugin

Shows today's [Taskbox](https://github.com/jsnjack/taskbox) agenda in the
panel:

- **The current task**, from 10 minutes before its moment until 10 minutes
  after, as accent text beside an alarm icon — be ready, then be in it.
- Otherwise **the number of tasks still due today** beside an unticked
  checkbox, in the warning color while anything is overdue.
- Otherwise **a green ticked checkbox**: the day is all good.

The menu lists the agenda: the overdue pile with when each entry slipped,
today's tasks in time order with a `↻` mark on recurring ones, and how many
were already finished today.

The indicator sits immediately right of the clock (`position: "center-end"`):
what is due next belongs beside what time it is.

## Symbols and colors

| Panel shows | Meaning |
|---|---|
| ⏰ `10:00 Standup`, accent color, larger | A task's moment is now: due within 10 minutes, or started up to 10 minutes ago |
| ☐ `5` | 5 tasks still due today |
| ☐ `5`, yellow | 5 tasks still due today, and at least one is overdue |
| ☑, green | Nothing due today |
| nothing | Taskbox is not installed, not connected, or its data is stale |

In the menu, `HH:MM · title` is a timed task, a bare title is due sometime
today, `↻` marks a recurring task, and an overdue entry leads with the time
or day it slipped.

## Data source

The plugin runs `taskbox agenda`, which prints a versioned JSON document from
Taskbox's local SQLite copy of the account. That is deliberate: it answers
offline, it always agrees with the Taskbox window about what "today" holds,
and this plugin needs no credential and performs no network I/O. Taskbox's
own background synchronization keeps the data fresh.

Taskbox must be installed on the PATH (the RPM installs `/usr/bin/taskbox`)
and connected to a Todoist account. Until then the plugin reports a failure
and, with the manifest's `failurePolicy: "hide"`, stays out of the panel.

## Behavior notes

- The refresh interval is one minute, so the current-task window can open up
  to a minute late.
- A timed task that has slipped can still be the current task: five minutes
  past its moment, it is what the panel should be pointing at.
- When two windows overlap, the nearest moment wins.
- Notes never appear: Taskbox keeps notes undated, so they are not part of
  any day's agenda.
