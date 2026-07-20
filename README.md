# pico-argos

`pico-argos` is a performance-first, universal GNOME Shell status extension for
bounded structured output from executable plugins.

The project is implementing the Phase 0 performance harness defined in
[SPEC.md](./SPEC.md). The current extension provides one persistent fixed-width
panel label and three synthetic workloads selected from its menu:

- `constant` invokes the update path every 250 ms with unchanged text.
- `changing` applies same-width text changes every 250 ms.
- `spawn` measures one serialized `/usr/bin/true` launch each second.

The harness records bounded monotonic duration histograms and actor-mutation
counters in the default `summary` diagnostics mode. The `off` GSettings value
disables collection for overhead comparisons. Its menu can start or stop a
30-second detailed trace. Changed label writes arm feature-detected stage hooks
for at most 100 ms, and events enter a fixed 16,384-slot numeric ring. Trace
serialization runs in bounded idle slices, writes asynchronously below
`$XDG_CACHE_HOME/pico-argos/diagnostics/`, and emits `TraceReady` with the
completed path. The target-system A/B capture remains Phase 0 work.

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

The universal runtime will provide two plugin modes after the Phase 0 gate:

- `oneshot` runs bounded, low-frequency command or network queries.
- `stream` supervises one persistent process for frequent or stateful updates
  without recurring process creation.

The version 1 manifest and output protocol core is implemented as pure GJS.
It strictly rejects unknown fields, normalizes immutable manifests and
snapshots, accepts HTTPS links only, suppresses identical raw and semantic
state, and emits keyed panel/menu change sets. Process discovery and execution
are the next runtime layer.

CPU, memory, disk, network, GitHub, VPN, and weather behavior will be reference
plugins, not features embedded in the extension runtime.

Run the repository validation gate with:

```bash
npm install
make check
```

Build the installable GNOME Shell 50 package with `make package`. Use
`make install` only when an explicit local installation is intended.
