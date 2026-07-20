# AGENTS.md

> See [AGENTS.universal.md](./AGENTS.universal.md) and
> [AGENTS.gjs.md](./AGENTS.gjs.md) for universal and GJS GNOME Shell extension
> conventions. Refresh: `make standards`

---

## Overview

`pico-argos` is a performance-first, universal GNOME Shell status extension.
It renders bounded structured output from user-installed executable plugins.
The core knows only plugin manifests, process lifecycle, protocol validation,
semantic state, rendering, and diagnostics; domain integrations remain plugins.

The current repository is in the specification phase. Treat `SPEC.md` as the
normative product and technical contract until source code and tests exist.

---

## Architecture

```text
SPEC.md                    Normative behavior, protocol, limits, and delivery gates
AGENTS.universal.md        Shared engineering conventions
AGENTS.gjs.md              GNOME Shell and GJS conventions
Makefile                   Single validation and future packaging entry point
pico-argos@jsnjack.github.io/   Future installable extension source only
plugins/                   Future reference plugins, outside the extension artifact
tests/                     Future integration and performance fixtures
```

The installable extension package must not contain reference plugins. Core and
plugins communicate exclusively through the public versioned protocol.

---

## Key Flows

1. `PluginRegistry` asynchronously discovers and validates plugin manifests.
2. `RuntimeManager` schedules a bounded one-shot process or supervises a
   bounded persistent stream process.
3. A runner frames, decodes, parses, and validates one protocol snapshot.
4. `StateStore` rejects raw and semantic no-ops and emits a minimal change set.
5. `RenderCoordinator` coalesces changes and updates persistent leaf actors.
6. `Diagnostics` records bounded phase timing without logging ordinary cycles.

---

## Build & Run

```bash
make check       # complete non-installing validation gate
make test        # GJS unit tests once tests exist
make package     # build the extension zip once source exists
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

- No implementation exists yet; the repository currently contains the approved
  technical direction and project standards only.
- Distribution through extensions.gnome.org is not assumed because arbitrary
  executable plugin support may conflict with review policy.
