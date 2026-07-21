# pico-argos plugin guide for agents

> This filename intentionally matches the project request. In pico-argos,
> executable status integrations are called **plugins** even when migrating an
> Argos extension. Read [SPEC.md](./SPEC.md) for the normative contract and the
> root [AGENTS.md](./AGENTS.md) before changing production code.

## Purpose and boundaries

pico-argos is a universal GNOME Shell 50 status runtime. The core discovers,
runs, validates, diffs, and renders plugin output. It must never learn domain
logic for weather, GitHub, VPNs, hardware, or another integration. Put that
logic in a user-installed plugin and communicate exclusively through protocol
version 1.

Treat plugins as trusted executables whose output crosses an untrusted-data
boundary. Keep all work bounded. Never add an unbounded read, output history,
recurring shell pipeline, detached child, or daemon. Never import extension
internals from a plugin. Reference plugins live in [`plugins/`](./plugins/) and
must remain outside the packaged Shell extension.

## Using pico-argos

Install development dependencies, validate, package, and explicitly install:

```bash
npm install
make check
make package
make install
gnome-extensions enable pico-argos@jsnjack.github.io
```

`make check` includes a real GNOME 50 nested-Wayland session. Do not claim that
full performance acceptance passed merely because packaging or unit tests pass.
On Wayland, replacing extension code normally requires a nested Shell or a
logout/login cycle. Open settings with:

```bash
gnome-extensions prefs pico-argos@jsnjack.github.io
```

Plugins are installed separately below:

```text
$XDG_CONFIG_HOME/pico-argos/plugins/<plugin-id>/
  plugin.json
  run
```

If `XDG_CONFIG_HOME` is unset, GLib uses `$HOME/.config`. To install a reference
plugin from this checkout, preserve a private, user-owned tree:

```bash
plugin_root="${XDG_CONFIG_HOME:-$HOME/.config}/pico-argos/plugins"
install -d -m 700 "$plugin_root"
cp -R plugins/weather "$plugin_root/weather"
chmod -R go-w "$plugin_root/weather"
```

The checked-in reference `run.js` files are executable and copied with that
mode. Their manifests still use the specification's explicit
`["gjs", "-m", "./run.js"]` argv. The registry creates the root when needed,
loads at most 16 plugins, and rejects
plugin roots, directories, manifests, or directly executed files that are not
owned by the current user or are group/world writable. A direct `./run` needs
its executable bit; an interpreter command such as
`["gjs", "-m", "./run.js"]` does not require `run.js` itself to be executable.
Prefer atomic temporary-file replacement for manifests and executables. The
registry debounces changes and retains the last valid definition while a new
manifest is incomplete or invalid.

Environment variables are opt-in through `passEnvironment`. Variables added to
a terminal after GNOME Shell starts are not retroactively visible to the Shell.
For reference GitHub plugins, place the required values in the session startup
environment and log out/in. Never put tokens in argv, stdout, menu text,
diagnostics, or a manifest. A wrapper may read a user-private secret file when
session environment configuration is unsuitable.

## Choosing an execution mode

Use `oneshot` for bounded, infrequent work such as one HTTP query. It produces
exactly one snapshot and exits successfully. pico-argos phases intervals,
coalesces duplicate work, prioritizes menu-open refreshes, and runs at most one
one-shot child globally.

Use `stream` for frequent or stateful updates where recurring spawn cost would
matter. One foreground process emits newline-delimited snapshots and optional
heartbeats. pico-argos permits at most four stream children, serializes starts,
and applies bounded exponential restart/backoff. The plugin must flush each
line, stay in the foreground, and exit when its stdout closes or it is
terminated. It must not daemonize or leave grandchildren.

## Version 1 manifests

A minimal one-shot manifest is:

```json
{
  "manifestVersion": 1,
  "id": "example-status",
  "mode": "oneshot",
  "command": ["./run", "--compact"],
  "intervalMs": 300000,
  "timeoutMs": 15000,
  "refreshOnOpen": true,
  "position": "right",
  "order": 50,
  "nice": 10,
  "reserveTextChars": 8,
  "passEnvironment": ["EXAMPLE_TOKEN"],
  "failurePolicy": "keep-last",
  "maxStaleMs": 600000
}
```

A minimal stream manifest is:

```json
{
  "manifestVersion": 1,
  "id": "example-stream",
  "mode": "stream",
  "command": ["gjs", "-m", "./run.js"],
  "startupTimeoutMs": 5000,
  "heartbeatTimeoutMs": 10000,
  "maxMessagesPerSecond": 2,
  "maxBytesPerMinute": 262144,
  "position": "right",
  "order": 0,
  "nice": 10,
  "reserveTextChars": 16,
  "passEnvironment": [],
  "failurePolicy": "show-error",
  "maxStaleMs": 30000
}
```

The exact rules are:

- `manifestVersion` is `1`. Unknown or wrong-mode fields are rejected.
- `id` matches its directory and
  `[a-z0-9][a-z0-9._-]{0,63}`.
- `command` is an argv array, not a shell string: 1–32 elements, each at most
  4,096 UTF-8 bytes and at most 16 KiB total. A path is resolved inside the
  plugin directory; a bare program uses the runtime's minimal `PATH`.
- `position` is `left`, `center`, or `right`; ordering is by position, integer
  `order`, then ID.
- `nice` is `null` or 0–19 and defaults to 10. `null` disables the niceness
  wrapper.
- `reserveTextChars` is 0–128. A nonzero value is a hard Unicode-scalar limit,
  not truncation. With `appearance: "monospace"`, it also reserves stable panel
  width.
- `passEnvironment` has at most 16 unique shell variable names. It cannot name
  the runtime's fixed `HOME`, locale, `PATH`, XDG, or `PICO_ARGOS_*` variables.
- `failurePolicy` is `keep-last`, `hide`, or `show-error`.
- `maxStaleMs` is `null` or 1–604,800,000. In one-shot mode it cannot be less
  than `intervalMs`.
- One-shot `intervalMs` is 1,000–86,400,000; `timeoutMs` is 100–30,000 and less
  than the interval; `refreshOnOpen` is boolean.
- Stream `startupTimeoutMs` is 100–30,000 (default 5,000),
  `heartbeatTimeoutMs` is 0 or 1,000–300,000 (default 0),
  `maxMessagesPerSecond` is 1–10 (default 2), and `maxBytesPerMinute` is
  65,536–1,048,576 (default 262,144).

Every child receives only the runtime's minimal base environment, allowlisted
values, and:

```text
PICO_ARGOS_PROTOCOL=1
PICO_ARGOS_PLUGIN_ID=<plugin-id>
PICO_ARGOS_MENU_OPEN=true|false  # one-shot only
```

The working directory is the plugin directory. Use
`PICO_ARGOS_MENU_OPEN=true` to include or refresh expensive menu details only
when useful, but still emit a complete valid snapshot.

## Version 1 output

Write one compact UTF-8 JSON object. A snapshot example is:

```json
{"version":1,"type":"snapshot","panel":{"text":"2 🤖","appearance":"compact","accessibleName":"2 critical dependency alerts","severity":"critical"},"menu":[{"id":"alerts","kind":"link","text":"View Vulnerabilities","uri":"https://github.com/example/project/security/dependabot"}]}
```

`panel` may be `null` to hide the indicator. Otherwise:

- `visible` defaults to true.
- A visible panel needs `text` or an icon-theme `icon`.
- `text` is plain text with no controls/newlines and at most 128 Unicode scalar
  values. Markup and Argos `| key=value` attributes are not interpreted.
- `appearance` is `normal`, `compact`, or `monospace`.
- `severity` is `normal`, `warning`, or `critical`.
- `accessibleName` is mandatory for icon-only state and should explain terse
  glyphs or abbreviations.

`menu` contains at most 64 entries with stable, unique IDs:

```json
{"id":"country","kind":"label","text":"Connected to NL"}
{"id":"group-1","kind":"separator"}
{"id":"reviews","kind":"link","text":"Review requested","uri":"https://github.com/pulls/review-requested"}
```

Text is plain, nonempty, newline-free, and at most 512 Unicode scalars. Links
must be valid HTTPS URIs of at most 2,048 bytes. Use separate labels and
separators for layout. Plugins cannot send callbacks, CSS, JavaScript, shell
commands, nested menus, arbitrary icons, or markup.

One-shot stdout contains exactly one document, no extra logging, and is at most
64 KiB. Exit zero only after writing the full document. Put diagnostics on
stderr; one-shot stderr is capped at 8 KiB.

A stream writes one document per line and may use this exact heartbeat:

```json
{"version":1,"type":"heartbeat"}
```

Each stream line and partial-line buffer is capped at 64 KiB. Heartbeats consume
message and byte budgets. Stream stderr retains an 8-KiB tail and may emit no
more than 64 KiB/minute. Invalid UTF-8, malformed JSON, schema errors, excess
output, rate breaches, liveness failure, or unexpected exit fail the run.

## Preserving look and behavior during migration

Start by translating the original indicator without changing its behavior.
Keep panel placement and order, refresh cadence, conditional visibility, data
source, link destinations and grouping, fixed-width padding, units, and
accessible meaning. Use literal Unicode when a glyph remains part of the
design, and prefer GNOME symbolic icon names when polishing a status into a
native Shell presentation. Replace blank Argos lines with stable separators or
purposeful labels. Use `appearance: "monospace"` and an accurate
`reserveTextChars` for fixed-width values. A combined plugin is acceptable when
the specification requires it, but preserve the old tokens and visual rhythm
as the default during that transition.

After behavioral parity is covered by tests, presentation can be refined with
explicit approval. For Fedora 44 and GNOME 50, the maintained reference style
is deliberately restrained:

- use icon-theme symbolic icons and inherited panel/menu colors;
- keep icon-only states fully accessible and pair alert icons with a short
  numeric count when useful;
- use concise sentence-case menu labels, stable separators, and direct links
  to the most actionable items;
- hide genuinely inactive status instead of showing decorative all-clear text,
  except where an always-visible state is part of the original workflow;
- avoid custom backgrounds, borders, shadows, markup, and domain-specific CSS;
- use the core warning/critical severity colors only for actionable thresholds;
- cap detail lists and summarize onset, peak, or totals before raw entries.

These choices let the Shell theme control spacing, contrast, symbolic-icon
rendering, hover states, and light/dark/high-contrast behavior. Domain plugins
should not try to reproduce GTK cards or invent a second panel theme.

Do not change a legacy data source merely because another API is easier. These
reference defaults are compatibility constraints:

| Plugin | Required source/default | Maintained presentation |
|---|---|---|
| system monitor | Linux `/proc` and `/sys` counters | legacy `cpu`/`mem`/`io`, arrows, `KBs`/`MBs`, and 9 px monospace remain the default; compact is opt-in |
| Dependabot | GitHub Dependabot alerts API | hidden at zero; urgent-update symbolic icon and count; up to five direct alert links |
| pull reviews | GitHub GraphQL search | symbolic all-clear/review state, bounded requested-pull links, and the existing workflow destinations |
| VPN | `https://web-api.nordvpn.com/v1/ips/info` | hidden when unprotected; VPN symbolic icon; private country/city details with no public IP |
| weather | `https://weather.yauhen.cc/api/v1/glance` | center placement, temperature/rain dots/condition icon, concise details, and bounded rain timing |

The `weather.yauhen.cc` source is deliberate. **Do not replace, proxy, or add a
fallback weather source without an explicit user request.** Fetch it once per
run, cap the response, parse JSON once, and preserve last valid state on a
transient failure.

Core constraints still win where raw Argos behavior was unsafe: errors appear
in diagnostics instead of repainting `...`; output is strict and bounded;
network calls time out before the manifest deadline; and repeated identical
state performs zero UI writes.

## Authoring workflow

1. Read the relevant sections of [SPEC.md](./SPEC.md), then inspect the nearest
   reference plugin. Keep data-source logic out of the extension directory.
2. Define panel/menu semantic state in a pure `logic.js`. Give every menu row a
   deterministic ID that survives value changes and reordering.
3. Keep `run.js` small: validate configuration, perform bounded I/O, parse once,
   call the pure logic function, serialize once, and write once. Use argv and
   library APIs instead of spawning `curl`, `jq`, `awk`, or shell pipelines.
4. Add `logic.test.js` edge cases plus a strict protocol parse test. Cover zero,
   normal, maximum/clamped, malformed-source, and conditional-menu states.
5. Validate the manifest with the public parser and run `make check`.
6. Install the plugin into a private config tree and verify placement, first
   menu open, unchanged refreshes, failure policy, hot replacement, and
   enable/disable teardown in a nested or login Shell.
7. Compare visually with the original extension before declaring migration
   complete. Document every intentional incompatibility.

Design for semantic no-ops. Do not put timestamps, random IDs, countdowns, or
reformatted equivalent values in snapshots unless visible state truly changed.
Keep panel width constant where practical. Stable snapshots let StateStore stop
work before render; stable menu IDs let one changed row update one retained
actor.

## Diagnostics and troubleshooting

Use the preferences Diagnostics page for sanitized plugin health, process
state, rates, no-op counts, timeouts, restarts, backoff, phase percentiles, and
trace controls. A locked stream has a `Restart stream` item in its own menu.
The summary is also available without exposing plugin output or secrets:

```bash
gdbus call --session \
  --dest org.gnome.Shell.Extensions.PicoArgos \
  --object-path /org/gnome/Shell/Extensions/PicoArgos \
  --method org.gnome.Shell.Extensions.PicoArgos.Diagnostics1.GetSummary
```

Capture a bounded 30-second trace with `StartTrace 30`, then `StopTrace`. Trace
files are written asynchronously below the XDG cache directory. Ordinary
plugin output and environment values are never trace payloads.

When a plugin does not appear, check in this order: directory/manifest ID,
ownership and write permissions, manifest unknown fields, command resolution,
environment availability in GNOME Shell, protocol validity, byte/rate limits,
and process timeout/exit. Diagnose from bounded health and journal events; do
not add recurring logs to the success path.
