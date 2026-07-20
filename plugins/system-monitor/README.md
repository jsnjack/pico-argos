# system-monitor reference plugin

This persistent GJS plugin samples aggregate CPU and memory counters from
`/proc`, direct-device activity from `/sys`, and primary-interface byte counters
from `/proc/net/dev`. It starts no recurring child processes.

Copy this directory to
`$XDG_CONFIG_HOME/pico-argos/plugins/system-monitor/`. Optionally copy
`config.example.json` to `config.json` and select an explicit block device or
network interface where automatic resolution is ambiguous.
