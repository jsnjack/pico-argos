# pico-argos

`pico-argos` is a GNOME Shell 50 extension that displays status information
from executable plugins. Performance is a primary design constraint: plugin
work is bounded, unchanged state is filtered out, and panel actors are updated
in place.

The project started during the investigation of
[GNOME/mutter#4852](https://gitlab.gnome.org/GNOME/mutter/-/work_items/4852),
which reported persistent missed frames on a 120 Hz AMD laptop panel.
`pico-argos` was created to keep status-extension work predictable and make its
effect on the Shell main loop measurable.

## How it works

Plugins are user-installed programs that write versioned JSON. The extension:

- discovers plugins below `$XDG_CONFIG_HOME/pico-argos/plugins/`;
- runs occasional work in `oneshot` mode and frequent work in `stream` mode;
- limits process count, output size, rates, timeouts, and retries;
- validates output before replacing the last valid state;
- ignores identical raw output and equivalent semantic state;
- keeps panel and menu actors alive and applies only changed fields; and
- exposes bounded summaries and opt-in traces through preferences and D-Bus.

The extension contains no domain-specific integrations. Reference plugins live
outside the extension package:

| Plugin | Purpose |
|---|---|
| [System monitor](./plugins/system-monitor/README.md) | CPU, GPU, memory, disk, and network activity |
| [Dependabot](./plugins/dependabot/README.md) | GitHub dependency alerts |
| [Pull reviews](./plugins/pull-reviews/README.md) | Requested GitHub reviews |
| [VPN](./plugins/vpn/README.md) | VPN protection and location |
| [Weather](./plugins/weather/README.md) | Temperature, rain, and conditions |

## Install

The current target is Linux with GNOME Shell 50 on Wayland. Build and install
from this checkout with:

```bash
npm install
make check
make install
gnome-extensions enable pico-argos@jsnjack.github.io
```

Install plugins separately. For example:

```bash
plugin_root="${XDG_CONFIG_HOME:-$HOME/.config}/pico-argos/plugins"
install -d -m 700 "$plugin_root"
cp -R plugins/weather "$plugin_root/weather"
chmod -R go-w "$plugin_root/weather"
```

Open preferences to enable plugins and view diagnostics:

```bash
gnome-extensions prefs pico-argos@jsnjack.github.io
```

Plugin directories, manifests, and directly executed files must be owned by the
current user and must not be group- or world-writable.

## Write a plugin

A plugin directory contains `plugin.json` and the program named by its command
array. A snapshot looks like this:

```json
{"version":1,"type":"snapshot","panel":{"text":"42","accessibleName":"42 pending jobs"},"menu":[]}
```

Use `oneshot` for infrequent work and `stream` for a persistent foreground
process. Read the [plugin guide](./AGENTS.extensioons.md) for installation,
manifest, protocol, security, and migration rules. [SPEC.md](./SPEC.md) is the
normative technical contract.

## Development

Run the complete validation gate before committing:

```bash
make check
```

It runs formatting and specification checks, linting, GJS tests, package checks,
and a nested GNOME Shell acceptance session. The nested test requires a running
PipeWire session.

Other common targets are:

```bash
make test       # deterministic tests
make package    # build the extension zip
make install    # install the local package
make standards  # refresh project conventions
```

Detailed performance capture and physical A/B procedures are documented in
[tests/performance/README.md](./tests/performance/README.md). A green build does
not replace the target-hardware frame-latency and stability runs.
