# pico-argos

`pico-argos` is a performance-first, universal GNOME Shell status extension for
bounded structured output from executable plugins.

The production universal runtime defined in [SPEC.md](./SPEC.md) discovers
strict manifests below `$XDG_CONFIG_HOME/pico-argos/plugins/`, executes bounded
one-shot or persistent stream plugins, suppresses raw and semantic no-ops, and
coalesces all visible changes into at most ten UI batches per second.

Each accepted plugin owns persistent panel icon and label actors. Menu data
remains plain immutable state until first open; thereafter menu actors are
retained and updated by stable item ID. Adding, replacing, or removing one
plugin does not rebuild unrelated indicators.

The enabled extension exposes the versioned diagnostics interface from
`SPEC.md`. For example:

```bash
gdbus call --session \
  --dest org.gnome.Shell.Extensions.PicoArgos \
  --object-path /org/gnome/Shell/Extensions/PicoArgos \
  --method org.gnome.Shell.Extensions.PicoArgos.Diagnostics1.GetSummary

gdbus call --session \
  --dest org.gnome.Shell.Extensions.PicoArgos \
  --object-path /org/gnome/Shell/Extensions/PicoArgos \
  --method org.gnome.Shell.Extensions.PicoArgos.Diagnostics1.StartTrace 30
```

The universal runtime provides two plugin modes:

- `oneshot` runs bounded, low-frequency command or network queries.
- `stream` supervises one persistent process for frequent or stateful updates
  without recurring process creation.

The version 1 manifest and output protocol core is implemented as pure GJS.
It strictly rejects unknown fields, normalizes immutable manifests and
snapshots, accepts HTTPS links only, suppresses identical raw and semantic
state, and emits keyed panel/menu change sets. The asynchronous registry also
discovers only owned, non-writable plugin trees, enforces the global plugin
bound, orders valid manifests, and safely retains the prior definition while an
edited replacement is invalid. The one-shot scheduler uses one monotonic timer,
coalesces a single token per plugin, prioritizes menu refreshes, and dispatches
at most one child globally. Its runner drains both pipes asynchronously,
enforces byte and timeout limits, validates UTF-8, and reaps every direct child.
The stream path preserves UTF-8 sequences across reads, frames bounded lines,
enforces message/stdout/stderr rates and liveness, serializes starts, admits at
most four children, and locks persistent crash loops after bounded backoff.
Both execution modes feed one runtime/state path: heartbeats bypass state,
identical raw snapshots stop before parsing, semantic no-ops stop before UI
work, failure policies transition once, and staleness changes only on coarse
ticks. The default `summary` diagnostics mode records bounded histograms and
mutation counters. Transient traces use a fixed 16,384-slot ring, bounded idle
serialization, asynchronous export below the XDG cache directory, and the
versioned D-Bus interface shown above.
Run IDs, stream sequence IDs, child/pipe/decode timings, message and byte
counters, restart/backoff state, output rejections, UI queue/apply phases, and
mutation-armed stage events are correlated without exporting plugin output or
environment values.

The preferences window exposes the persistent diagnostics mode, on-demand
plugin health, bounded phase percentiles, actor mutation totals, and trace
record/stop/export/reset controls. It polls the live summary only while the
Diagnostics page is visible.

CPU, memory, disk, and network behavior is provided by the optional
`plugins/system-monitor` stream plugin, not the extension core. It samples
retained Linux counter sources from one persistent GJS process, uses actual
monotonic elapsed time, and emits one fixed-width combined indicator. GitHub,
VPN, and weather integrations follow the same public plugin protocol.

Run the repository validation gate with:

```bash
npm install
make check
```

`make check` includes deterministic GJS tests, package-content assertions, and
a GNOME 50 nested-Wayland integration run. The nested run exercises production
enable/disable, stream teardown, settings, manifest and executable replacement,
trace export, preferences startup, and the actor-mutation assertions from the
performance contract.

Build the installable GNOME Shell 50 package with `make package`. Use
`make install` only when an explicit local installation is intended.
