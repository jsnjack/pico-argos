# AGENTS.md

> See [AGENTS.universal.md](./AGENTS.universal.md) and
> [AGENTS.gjs.md](./AGENTS.gjs.md) for universal and GJS GNOME Shell extension
> conventions. Refresh: `make standards`

For installing, using, authoring, or migrating executable status plugins, read
[AGENTS.extensioons.md](./AGENTS.extensioons.md) before making changes.

---

## Overview

`pico-argos` is a performance-first, universal GNOME Shell status extension.
It renders bounded structured output from user-installed executable plugins.
The core knows only plugin manifests, process lifecycle, protocol validation,
semantic state, rendering, and diagnostics; domain integrations remain plugins.

The repository contains the production universal runtime, reference plugins,
diagnostics, preferences, and nested-Shell acceptance harness on top of the
Phase 0 performance instrumentation. Treat `SPEC.md` as the normative product
and technical contract.

---

## Architecture

```text
SPEC.md                         Normative behavior, protocol, limits, and delivery gates
AGENTS.universal.md             Shared engineering conventions
AGENTS.gjs.md                   GNOME Shell and GJS conventions
Makefile                        Validation, staging, packaging, and installation
package.json                    Pinned project development tooling
pico-argos@jsnjack.github.io/   Installable GNOME Shell 50 extension source
  extension.js                  Production lifecycle entry point
  lib/                          Diagnostics, runtime, state, and persistent rendering
  schemas/                      Extension GSettings schema
plugins/                        Reference protocol plugins, outside the extension artifact
tests/                          Runner fixtures and nested-Shell integration tests
```

The installable extension package must not contain reference plugins. Core and
plugins communicate exclusively through the public versioned protocol.

---

## Key Flows

The implemented production flow and its retained Phase 0 instrumentation are:

1. `PerformanceController` owns the enabled generation, timer, and synthetic
   child process.
2. `SyntheticOutput` produces constant or fixed-width changing values.
3. `DistinctText` rejects semantic no-ops before the persistent label is
   written.
4. `Diagnostics` records bounded mutation counts and monotonic duration
   histograms unless collection is off.
5. A transient trace stores numeric events in a fixed ring and `StageTrace`
   arms feature-detected stage signals only after a visible label write.
6. `DiagnosticService` exposes bounded summary and transient trace controls on
   the versioned session D-Bus interface.
7. Stopped traces are encoded in bounded idle slices, written asynchronously
   below the XDG cache directory, and announced through `TraceReady`.
8. `manifest.js`, `protocol.js`, and `state.js` provide the Shell-independent
   version 1/2 validation and semantic no-op core used by the runtime.
9. `PluginRegistry` asynchronously validates owned plugin trees, publishes an
   ordered initial set, and debounces atomic manifest/executable replacement.
10. `OneShotScheduler` deterministically phases deadlines, coalesces bounded
    work, and serializes dispatch to `OneShotRunner`, which concurrently drains,
    limits, terminates, and reaps each direct child.
11. `StreamRunner` incrementally frames UTF-8 lines, enforces liveness and
    token buckets, and serializes bounded protocol-v2 stdin actions;
    `StreamSupervisor` serializes at most four child starts and applies bounded
    exponential restart and lockout policy.
12. `RuntimeManager` joins both execution modes to `StateStore`, publishes only
    minimal changes, applies failure/staleness transitions, and rejects panel
    text that exceeds a manifest's reserved allocation.
13. `RenderCoordinator` collapses each plugin to its latest presentation and
    caps global batches at 10/s; `PluginIndicator` retains panel leaves,
    creates keyed menu actors only on first open, and routes data-only action
    IDs back to current interactive streams.
14. `ExtensionController` wires the monitored registry, runtimes, renderer, and
    production diagnostic interface with generation-guarded teardown.
15. `prefs.js` reads the live bounded summary only while its Diagnostics page
    is visible and exposes summary mode, trace, export/stop, and reset controls.
16. Runner events share monotonically increasing run IDs, stream messages carry
    per-run sequence IDs, and trace events correlate launch, framing, state,
    UI queue/apply, and mutation-armed stage timing without retaining output.

The production universal runtime flow is:

1. `PluginRegistry` asynchronously discovers and validates plugin manifests.
2. `RuntimeManager` schedules a bounded one-shot process or supervises a
   bounded persistent stream process.
3. A runner frames, decodes, parses, and validates one protocol message; an
   interactive stream may also receive one bounded activation request.
4. `StateStore` rejects raw and semantic no-ops and emits a minimal change set.
5. `RenderCoordinator` coalesces changes and updates persistent leaf actors.
6. `Diagnostics` records bounded phase timing without logging ordinary cycles.

---

## Build & Run

```bash
npm install      # install pinned project development tooling
make check       # complete non-installing validation gate
make test        # deterministic GJS unit and fixture tests
make package     # build the extension zip
make install     # explicitly install the local package
make standards   # refresh shared standards from jsnjack/standards
```

GNOME Shell integration and frame-latency acceptance require a nested Wayland
Shell or a login cycle on the target GNOME version. Never treat successful
packaging or average CPU usage as performance acceptance.

---

## Configuration

Plugin directories live under
`$XDG_CONFIG_HOME/pico-argos/plugins/<plugin-id>/`. Each contains `plugin.json`
and an executable declared by an argv array. The extension's GSettings schema
is `org.gnome.shell.extensions.pico-argos`; domain-specific plugin configuration
does not belong in that schema.

---

## Design Decisions

- The core contains no CPU, GitHub, VPN, weather, or other domain logic.
- One-shot mode serves infrequent work, while stream mode serves frequent or
  stateful work where recurring spawn cost is unacceptable.
- Persistent actors and semantic diffing ensure unchanged state performs zero
  UI writes.
- Output size, rate, concurrency, timeout, heartbeat, and restart limits protect
  the Shell main process.
- Summary diagnostics are bounded, and detailed traces are opt-in and
  time-limited.

---

## Gotchas

- Extension JavaScript and async completion callbacks run in GNOME Shell's main
  context; all synchronous phases are compositor-critical.
- `Gio.Subprocess` creation is synchronous even when pipe I/O and waiting are
  asynchronous.
- Killing a direct child does not kill detached grandchildren. Plugins must stay
  in the foreground and must not daemonize.
- A visible panel change necessarily requests a repaint. The extension can
  minimize mutations but cannot repair a lower-level Mutter or driver defect.
- Changes to extension code on Wayland normally require a nested Shell or a
  logout/login cycle.

---

## Known Issues

- Target-hardware dual-120-Hz A/B, full-workload, and one-hour stability
  measurements remain outstanding and require the external display connected.
- Distribution through extensions.gnome.org is not assumed because arbitrary
  executable plugin support may conflict with review policy.
