# pico-argos

`pico-argos` is a performance-first, universal GNOME Shell status extension for
bounded structured output from executable plugins.

The project is currently in its specification phase. See [SPEC.md](./SPEC.md)
for the protocol, architecture, performance budgets, diagnostics, reference
plugin migrations, test matrix, and acceptance criteria.

The core will provide two plugin modes:

- `oneshot` runs bounded, low-frequency command or network queries.
- `stream` supervises one persistent process for frequent or stateful updates
  without recurring process creation.

CPU, memory, disk, network, GitHub, VPN, and weather behavior will be reference
plugins, not features embedded in the extension runtime.

Run the repository validation gate with:

```bash
make check
```
