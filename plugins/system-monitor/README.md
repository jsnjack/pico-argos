# system-monitor reference plugin

This persistent GJS plugin samples aggregate CPU and memory counters from
`/proc`, direct-device activity from `/sys`, and primary-interface byte counters
from `/proc/net/dev`. It starts no recurring child processes.

Copy this directory to
`$XDG_CONFIG_HOME/pico-argos/plugins/system-monitor/`. Optionally copy
`config.example.json` to `config.json` to select displayed fields, adjust
sampling intervals, or select an explicit block device or network interface
where automatic resolution is ambiguous.

The combined label keeps the legacy `cpu`, `mem`, and `io` tokens plus the
down/up arrows, two-decimal `KBs`/`MBs` rates, and 9-pixel monospace styling.
Putting the four readings in one persistent indicator removes recurring child
processes without making the panel presentation unfamiliar.

`presentation` defaults to `legacy`. Set it to `compact` for the cleaner
uppercase, abbreviated-rate layout; both layouts remain fixed-width. Optional
per-metric warning and critical thresholds change only the extension-owned
severity style. The menu aligns detailed values and identifies the resolved
block device and network interface without adding recurring work.

For physical acceptance only, `diagnosticTracePath` may be set to an absolute
path in an already-created private directory. The plugin then retains at most
16,384 numeric fast-cycle records and exports them when it receives SIGINT or
SIGTERM. Each record correlates the scheduled 250-ms deadline, sample,
formatting, pipe-write, and output sequence timestamps with the extension's
bounded trace. It is disabled by default and does no allocation or file output
on ordinary runs.
