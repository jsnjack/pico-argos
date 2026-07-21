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
