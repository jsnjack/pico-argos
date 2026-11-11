# system-monitor reference plugin

This persistent GJS plugin samples aggregate CPU and memory counters from
`/proc`, GPU and direct-device activity from `/sys`, and primary-interface byte
counters from `/proc/net/dev`. It starts no recurring child processes.

Copy this directory to
`$XDG_CONFIG_HOME/pico-argos/plugins/system-monitor/`. Optional settings
select displayed fields, adjust sampling intervals, or select an explicit block
device or network interface where automatic resolution is ambiguous; see
[Configuration](#configuration).

The combined label keeps the legacy `cpu`, matching `gpu`, `mem`, and `io`
tokens plus the down/up arrows, two-decimal `KBs`/`MBs` rates, and 9-pixel
monospace styling. Putting the readings in one persistent indicator removes
recurring child processes without making the panel presentation unfamiliar.

GPU usage comes from the kernel DRM device's `gpu_busy_percent` counter. Auto
selection prefers the boot display adapter and otherwise uses the first
readable DRM card. Set `gpuDevice` to an explicit `cardN` when needed. Systems
without that kernel counter retain the fixed-width `gpu  --%` placeholder
instead of spawning a vendor utility.

`presentation` defaults to `legacy`. Set it to `compact` for the cleaner
uppercase, abbreviated-rate layout; both layouts remain fixed-width. Optional
per-metric warning and critical thresholds change only the extension-owned
severity style of the whole label. CPU, GPU, and disk activity spike briefly
during ordinary work, so each of their thresholds takes effect only after
3 seconds of samples at or above it, and clears only after 3 seconds below it.
Memory follows the current sample. The menu aligns detailed values and
identifies the resolved block device and network interface without adding
recurring work.

For physical acceptance only, `diagnosticTracePath` may be set to an absolute
path in an already-created private directory. The plugin then retains at most
16,384 numeric fast-cycle records and exports them when it receives SIGINT or
SIGTERM. Each record correlates the scheduled 250-ms deadline, sample,
formatting, pipe-write, and output sequence timestamps with the extension's
bounded trace. It is disabled by default and does no allocation or file output
on ordinary runs.

## Configuration

Settings live in the `plugins.system-monitor` object of
`$XDG_CONFIG_HOME/pico-argos/config.json`. Every key is optional. This example
narrows the fields and colors the label at high CPU and memory use:

```json
{
  "plugins": {
    "system-monitor": {
      "fields": ["cpu", "memory", "network"],
      "presentation": "compact",
      "thresholds": {
        "cpu": {"warning": 85, "critical": 95},
        "memory": {"warning": 85, "critical": 95}
      }
    }
  }
}
```

| Key | Default | Accepted values |
|---|---|---|
| `fastIntervalMs` | `250` | 100 through 2,000; the CPU, GPU, and network sampling interval |
| `diskIntervalMs` | `500` | 100 through 10,000 |
| `memoryIntervalMs` | `1000` | 100 through 10,000 |
| `fields` | `["cpu", "gpu", "memory", "disk", "network"]` | One or more of those names, each at most once |
| `gpuDevice` | `"auto"` | `"auto"` or a DRM card such as `"card1"` |
| `diskDevice` | `"auto"` | `"auto"` or a block device such as `"nvme0n1"` |
| `networkInterface` | `"auto"` | `"auto"` or an interface such as `"wlp0s20f3"` |
| `presentation` | `"legacy"` | `"legacy"` or `"compact"` |
| `thresholds` | `{}` | `warning` and `critical` percentages from 1 through 100 for `cpu`, `gpu`, `memory`, or `disk`; `warning` must be below `critical` |
| `diagnosticTracePath` | `null` | `null` or an absolute path |

pico-argos passes this object to the plugin as JSON in the `PICO_ARGOS_CONFIG`
environment variable. When the variable is not a JSON object, the plugin logs
`Ignoring invalid config.json plugins.system-monitor` and uses the defaults. An
unknown key or an out-of-range value stops the plugin with an error that names
the key.
