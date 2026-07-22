# Physical performance acceptance tooling

This directory holds the tooling that produces **physical** frame-latency and
long-run stability evidence for pico-argos, as distinct from `make check`,
which only proves protocol, lifecycle, and functional correctness inside a
nested Shell. See [`../../AGENTS.extensioons.md`](../../AGENTS.extensioons.md)
for what a physical performance claim must cite, and
[`../../SPEC.md`](../../SPEC.md) sections 3 and 17.5 for the normative
contract this tooling exists to validate.

Nothing here installs the extension or reloads a login session on its own.
Running the full acceptance matrix against the live Shell requires the exact
package already installed and a fresh explicit user authorization for the
required logout/login cycle, per the root [`AGENTS.md`](../../AGENTS.md).

## Components

| File | Purpose |
|---|---|
| `presentation-client.c` | Minimal Wayland client that continuously commits a 64x64 surface and records `wp_presentation_feedback` timing. |
| `build-presentation-client.sh` | Generates the `xdg-shell`/`presentation-time` protocol bindings and builds `presentation-client.c`. |
| `presentation.js` | Pure summarizer/comparator for presentation-feedback NDJSON. Unit-tested by `presentation.test.js`. |
| `analyze-presentation.js` | CLI: reads one NDJSON capture (and optional core trace) and prints a bounded summary. |
| `compare-presentation.js` | CLI: reads paired baseline/scenario summaries and prints a paired-comparison verdict. |
| `analyze-steady-state.js` | CLI: reads before/after diagnostic summaries and an RSS sample file and prints a one-hour stability verdict. |
| `monitor-state.js` | CLI: prints the current physical/logical monitor layout; `--require-dual-120` fails unless exactly two monitors are active at 120 Hz. |
| `capture-presentation-run.sh` | Captures one timed run: presentation NDJSON, diagnostics before/after, display state, `pidstat`, RSS samples, best-effort `perf`, and the journal window. |
| `run-acceptance.sh` | Stages isolated fixture/reference plugins, drives the full paired-run and one-hour matrix, and writes a final `result.json`. |
| `run-performance-report.sh` | Runs the full matrix and writes a detailed Markdown/terminal report, or regenerates the report from existing artifacts. |
| `run-redraw-ab.sh` | Alternates label-only updates and explicit panel-button redraws inside one live instrumented Shell session. |
| `correlation.js` / `analyze-correlation.js` | Correlates the system-monitor plugin's own sample deadlines with the core's opt-in UI-apply trace, independent of the presentation probe. |
| `plugins/perf-constant`, `perf-changing`, `perf-oneshot` | Minimal public-protocol fixture plugins used as isolated load scenarios (see below). |

Unit tests (`*.test.js`) are picked up automatically by `make test`, or run
individually with `gjs -m tests/performance/<name>.test.js`.

## 1. Build the presentation probe

```bash
tests/performance/build-presentation-client.sh /path/to/presentation-client
```

Requires `cc`, `pkg-config`, `wayland-scanner`, and the `wayland-client`
development package, plus installed `xdg-shell` and `presentation-time`
Wayland protocol XML (from `wayland-protocols`, or a Qt6 install providing the
same files). It builds with `-std=c11 -Wall -Wextra -Werror`. The nested
integration test (`tests/integration/nested-shell.sh`) builds its own copy
automatically; only build one by hand to run the tools in this directory
directly against a live or nested compositor.

## 2. Capture one timed run

```bash
export PICO_ARGOS_PRESENTATION_CLIENT=/path/to/presentation-client
tests/performance/capture-presentation-run.sh OUTPUT_DIR DURATION_SECONDS
```

`DURATION_SECONDS` is 10–86,400. Must run inside the target Wayland session
(`WAYLAND_DISPLAY` set) with `gnome-shell` reachable over the session bus.
Optional `PICO_ARGOS_SCENARIO`, `PICO_ARGOS_DIAGNOSTICS_MODE`,
`PICO_ARGOS_PAIR`, and `PICO_ARGOS_RUN_ROLE` are recorded verbatim into
`environment.json` for later grouping; `run-acceptance.sh` sets them
automatically. `OUTPUT_DIR` must not already exist.

The directory gets `summary-before.json`/`summary-after.json` (extension
diagnostics), `display-config.txt`, `environment.json` (commit, package
SHA-256, Shell/GJS versions, power profile, timestamps), `pidstat.txt` and
`process-memory.tsv` (Shell CPU/RSS over the run), `perf-stat.txt` (if `perf`
is available), `presentation.ndjson` (raw probe output), a trailing
`gnome-shell.journal.txt` window, and `presentation-summary.json` (the
analyzed result — see below).

## 3. Analyze one capture

```bash
tests/performance/analyze-presentation.js OUTPUT_DIR/presentation.ndjson [CORE_TRACE_JSON]
```

Prints delivered FPS, interval/callback-latency/submission-latency
percentiles (p50/p95/p99/max), discarded-frame count, refresh-period
histogram, count and largest cluster of intervals exceeding 1.5x the refresh
period, and a separate frame-pacing profile. The profile reports delayed
intervals, estimated missed refreshes, gaps longer than 2.5 refresh periods,
the worst gap, and freeze-like presentation gaps of at least 50 ms. This
distinguishes isolated 16.7 ms misses at 120 Hz from pauses that can plausibly
look like the original Argos freeze. When a core opt-in trace JSON is supplied
and its clock is `CLOCK_MONOTONIC`, the summary also reports how many intervals
(and long intervals) had a correlated `UI_APPLY_END` event. Bounded to 256 MiB
/ 500,000 NDJSON events; a full one-hour run at 120 Hz produces about 432,000
presented-frame lines (roughly 100 MB at this probe's line size), comfortably
inside both limits.

**Known limitation on real hardware:** per version 1 of the presentation-time
protocol, a compositor reports `refresh = 0` whenever an output's rate isn't
guaranteed constant — which includes VRR/Adaptive-Sync-capable displays even
when VRR isn't actively engaged. On such a display every captured frame has
`refreshNanoseconds: 0` (confirmed against this project's own dual-120-Hz
outputs), so the long-interval count and refresh-period histogram above read
as empty/zero unconditionally — this reflects the protocol working as
specified, not jank-free delivery. It does not affect delivered FPS or the
paired-comparison confidence interval in step 4, which remain authoritative.
The descriptive frame-pacing profile remains available by estimating the
active cadence from the fastest 10% of this continuously committing probe's
observed intervals. The report labels that source `observed-fastest-decile`;
it is useful for discriminating misses from freeze-like gaps but is not treated
as authoritative refresh metadata or an acceptance gate. The nested
virtual-monitor test fixture is not VRR-capable and reports real refresh
periods, so this fallback only applies to live acceptance runs.

## 4. Compare paired runs

```bash
tests/performance/compare-presentation.js \
  baseline-1.json scenario-1.json baseline-2.json scenario-2.json ...
```

Requires at least five interleaved baseline/scenario summary pairs (from step
3). Reports the mean delivered-FPS change, a Student-t 95% confidence
interval, and the frame-rate gate: **pass only if the absolute mean change is
at most 0.1%.** Exits nonzero on a failed gate.

## 5. One-hour steady-state check

```bash
tests/performance/analyze-steady-state.js \
  summary-before.json summary-after.json process-memory.tsv
```

Requires at least 30 Shell RSS samples. Reports whether the enabled-plugin set
and actor creation/destruction counters stayed identical across the run, the
Shell RSS minimum/maximum, first/last-quarter medians, an hourly linear
regression slope, and whether RSS was monotonically non-decreasing across the
whole run. Passes only when the plugin set and actor counts are stable and RSS
is not monotonically growing.

## 6. Verify the monitor layout

```bash
tests/performance/monitor-state.js --require-dual-120
```

Reads `org.gnome.Mutter.DisplayConfig` and fails unless exactly two monitors
are active, both within 119.5–120.5 Hz. Read-only; safe to run against the
live session at any time.

## 7. Run the full acceptance matrix

```bash
tests/performance/run-acceptance.sh /path/to/new-output-dir
```

Preconditions, all enforced: a Wayland session (`XDG_SESSION_TYPE=wayland`),
the exact package already installed (`gnome-extensions info` succeeds), and
`gdbus`/`gjs`/`gnome-extensions`/`gsettings`/`jq`/`make` on `PATH`. The output
directory must not already exist.

It stages isolated `perf-constant`/`perf-changing`/`perf-oneshot` fixtures
plus `perf-full-<name>` copies of every reference plugin
(`system-monitor`, `dependabot`, `pull-reviews`, `vpn`, `weather` — the
weather copy preserves the exact `weather.yauhen.cc` source), verifies the
dual-120-Hz layout, then for each of `diagnostics-mode` `summary`/`off` and
each scenario (`empty`, `constant`, `changing`, `oneshot`, `full`) captures
`PICO_ARGOS_PAIRS` (default 5, 5–20) interleaved baseline/scenario pairs at
`PICO_ARGOS_RUN_SECONDS` (default 60, 30–3600) each, alternating which role
runs first per pair, and compares them (step 4). It then captures one
continuous `PICO_ARGOS_ONE_HOUR_SECONDS` (default 3,600; 0 disables it;
otherwise 3,600–86,400) full-workload run and analyzes it (step 5).

Original extension enablement, `disabled-plugins`, and `diagnostics-mode`
are restored on exit, interrupt, or termination via an idempotent cleanup
trap; staged `perf-*` plugin directories are removed. `result.json` in the
output directory summarizes pass/fail across every comparison and the
one-hour check; a nonzero exit means at least one comparison or the
steady-state check failed its gate.

Every physical report applies to the hardware, display layout, power profile,
and software recorded in its artifacts. Do not generalize one machine's absolute
FPS to another machine; paired branch comparisons remain useful because both
roles run under the same recorded conditions.

## 8. Recommended: focused report in under five minutes

Run this from a terminal in the real GNOME Wayland login session, not from a
nested Shell, SSH session, or sandbox. The focused runner accepts any active
monitor count, resolution, refresh rate, or scale. It records the layout and
uses the cadence reported by presentation feedback, or the observed fastest
cadence when VRR causes the protocol to report zero. Do not connect, disconnect,
or reconfigure displays during one run.

Before starting:

1. Install the current package with `make install`; it contains the hidden
   diagnostic selector used by this focused test.
2. Log out and back in once if its installed JavaScript changed.
3. Enable pico-argos and the normal plugins whose redraw workload matters.
4. Install the probe dependencies from step 1 and ensure `gdbus`, `gjs`,
   `gnome-extensions`, `gsettings`, `jq`, `journalctl`, and `pidstat` are
   available. `perf` is optional.

The output path must not already exist:

```bash
result_dir="performance-results/redraw-ab-$(date +%Y%m%d-%H%M%S)"
PICO_ARGOS_RUN_SECONDS=20 \
PICO_ARGOS_PAIRS=5 \
tests/performance/run-redraw-ab.sh "$result_dir"
```

The default has 200 seconds of timed capture plus one-second settling between
roles, probe compilation, and report generation. It normally completes in about
3½–4 minutes.

### Focused methodology

The live extension and plugin set stay enabled for both roles. The baseline
writes changed label text and relies on Clutter's automatic damage. The scenario
performs the identical write and additionally queues a redraw on the parent
panel button. The runner changes the hidden `performance-explicit-redraw`
setting in the already-loaded Shell and confirms the selected branch over D-Bus;
it does not reload the extension between roles.

Five pairs alternate baseline/scenario order to reduce temperature and
time-order bias. A continuously committing 64×64 Wayland surface records actual
`wp_presentation_feedback` timestamps while `pidstat`, RSS samples, diagnostic
summaries, and the Shell journal provide supporting evidence. The probe window
does not contain pico-argos; it stimulates and measures the same compositor that
renders the real panel extension.

The quick decision compares paired FPS changes using a Student-t 95% confidence
interval and a practical ±1% effect margin:

- Entire interval below −1%: `MATERIAL REDRAW REGRESSION`.
- Entire interval above +1%: `MATERIAL REDRAW IMPROVEMENT`.
- Entire interval inside ±1%: `NO MATERIAL REDRAW EFFECT`.
- Interval crosses a boundary: `INCONCLUSIVE`.

Frame pacing is reported separately: intervals over 1.5 observed refresh
periods, gaps over 2.5 periods, estimated missed refreshes, the worst gap, and
freeze-like gaps of at least 50 ms. This distinguishes dropped refreshes from
the original visible-freeze symptom.

The runner restores the original redraw setting on success, failure, interrupt,
or termination. It writes raw artifacts, `result.json`, and a detailed
`report.md` below `$result_dir`.

Regenerate the report without measuring again:

```bash
tests/performance/run-performance-report.sh --report-only /path/to/output-dir
```

A nonzero exit can mean a material regression or an inconclusive result; the
report is still generated. Read its `Overall result` instead of treating exit
zero as the only sign that rendering completed.

## 9. Optional exhaustive release certification

The full matrix in step 7 remains available for release certification against
the historical dual-120-Hz target. It is intentionally not the everyday
diagnostic and, unlike the focused test, enforces that target display layout:

```bash
result_dir="performance-results/full-$(date +%Y%m%d-%H%M%S)"
tests/performance/run-performance-report.sh "$result_dir"
```

Its defaults are five pairs, 60 seconds per capture, two diagnostics modes,
five scenarios, and a 3,600-second stability phase: at least 9,600 seconds
(2 hours 40 minutes) of timed capture. `PICO_ARGOS_PAIRS`,
`PICO_ARGOS_RUN_SECONDS`, and `PICO_ARGOS_ONE_HOUR_SECONDS` override those
values within the bounds described in step 7.

## 10. What the Mutter DevKit window tests

`make check` starts a separate GNOME Shell 50 with Mutter DevKit, an isolated
D-Bus and XDG directory tree, and one virtual 1280×720@60 monitor. It unpacks the
production extension and runs a smoke plugin through discovery, process
lifecycle, protocol, diagnostics, preferences, trace export, reload, and
teardown checks. A test-only actor extension then imports the production
`PluginIndicator`, inserts actors into the nested panel, and performs retained
actor, menu, mutation, and redraw-branch assertions.

Those operations are programmatic and often finish too quickly to inspect in
the DevKit window. The two-second presentation probe there verifies only that
the test compositor supplies continuous feedback at 60 Hz. Nested DevKit
results prove functional integration; they are never physical performance,
artifact, 120-Hz, GPU-driver, or real-login-session evidence.
