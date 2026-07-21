# Performance-First GNOME Shell Status Extension

Status: Draft specification, version 0.1

Project name: `pico-argos`

Extension UUID: `pico-argos@jsnjack.github.io`

Target platform: Linux, GNOME Shell 50, Wayland

Implementation language: GJS using ES modules

License: `GPL-3.0-or-later`

“GJS-only” means the installed extension runtime is GJS and there is no
companion daemon. All displayed data comes from user-installed executable
plugins. Plugins may be Bash, Python, Go, GJS, or any other executable language;
they are separate processes and are not bundled into the extension package.

## 1. Normative Language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative. A MUST is a
release requirement. A SHOULD may be violated only with a documented reason and
a measurement showing that the alternative preserves the performance contract.

## 2. Product Goal

`pico-argos` is a universal, script-output-driven GNOME Shell status extension.
It turns bounded structured output from arbitrary executable plugins into
persistent panel indicators and menus. Its primary requirement is predictable
compositor latency, not compatibility with Argos or BitBar.

The project MUST provide reference plugins that replace the functionality
currently supplied by these Argos plugins:

- CPU utilization
- Memory utilization
- Block-device utilization
- Network receive and transmit rates
- Count of critical Dependabot alerts with a link to GitHub
- Count of pull requests awaiting review with related GitHub links
- VPN protection state and country
- Current weather, forecast summary, and rain timeline

The core extension MUST contain no knowledge of CPU, memory, disks, networks,
GitHub, VPNs, weather, or any other data domain. The same documented protocol
and runtime MUST serve all integrations.

The extension MUST remain diagnosable enough to correlate one plugin update
with GNOME Shell, Mutter, GPU-fence, and KMS timing captures.

## 3. Performance Contract

At 120 Hz, one refresh period is approximately 8.33 ms. The extension MUST treat
that as a shared compositor budget, not as time available to the extension.

The following invariants are mandatory:

1. Identical plugin output causes zero actor property writes, zero actor-tree
   mutations, and zero menu mutations.
2. Normal refreshes create and destroy no UI GObjects or Clutter actors.
3. Panel actors are created once at enable time and retained until the plugin
   is removed or the extension is disabled.
4. Menu actors are created lazily on first open and subsequently updated by key.
5. No runtime callback performs synchronous file, network, or DNS
   I/O.
6. No user plugin may provide unbounded input to GNOME Shell.
7. No one-shot plugin may overlap an earlier execution of itself.
8. Multiple completed updates are applied through one pending UI batch.
9. A plugin may mutate only its own leaf actors. It MUST NOT rebuild the panel,
   panel box, button, menu, or unrelated plugins.
10. Instrumentation is always available and MUST be bounded. Detailed tracing
    MUST be opt-in and time-limited.

Performance targets under the defined workload:

| Measurement | Target | Release failure |
|---|---:|---:|
| One synchronous JS phase, p99 | <= 0.50 ms | > 1.00 ms |
| One synchronous JS phase, observed maximum | <= 1.00 ms | > 2.00 ms |
| UI apply batch, p99 | <= 0.50 ms | > 1.00 ms |
| Parsing and validation of typical plugin output, p99 | <= 0.25 ms | > 0.50 ms |
| Actor creations during an ordinary refresh | 0 | > 0 |
| Actor destructions during an ordinary refresh | 0 | > 0 |
| UI writes for unchanged output | 0 | > 0 |
| One-shot stdout | <= 64 KiB/run | > 64 KiB terminates the run |
| One-shot stderr | <= 8 KiB/run | > 8 KiB terminates the run |
| Stream line size | <= 64 KiB | > 64 KiB terminates the process |
| Stream output rate | <= configured budget, default 256 KiB/min | Budget violation terminates the process |
| Menu items per plugin | <= 64 | Output is rejected above 64 |
| One-shot minimum interval | 1,000 ms | Lower values are invalid |
| Loaded plugins | <= 16 | Additional plugins are rejected |
| Concurrent one-shot children | 1 | > 1 |
| Persistent stream children | <= 4 | Additional streams are rejected |
| Stream message rate | <= configured rate, default 2/s | Excess messages terminate the process |
| UI batches | <= 10/s globally | Further updates are coalesced |
| First lazy menu construction | <= 4.00 ms | > 8.00 ms |
| Changed CPU/network sample deadline to UI apply, p95 | <= 350 ms | > 750 ms |

The ordinary phase thresholds exclude enable/disable, plugin add/remove, and
the separately measured first lazy menu construction. The thresholds are
wall-clock durations measured with
`GLib.get_monotonic_time()`. Scheduler preemption may inflate an individual
measurement; therefore every violation is recorded and correlated rather than
silently discarded.

Passing microbenchmarks is necessary but not sufficient. Release acceptance
also requires no measurable frame-rate regression and no update-correlated
presentation-gap clusters on the target dual-120-Hz AMD system.

## 4. Explicit Non-Goals

Version 1 will not provide:

- Argos or BitBar output compatibility
- Arbitrary Pango markup
- ANSI escape interpretation
- Emoji-name expansion such as `:name:`
- Base64 images or per-update image decoding
- Arbitrary colors, fonts, or CSS supplied by plugins
- JavaScript `eval`
- Shell command strings interpreted by the extension
- Plugin-provided terminal commands
- Nested menus
- Sub-second one-shot plugin polling
- Domain-specific data collectors implemented inside the extension
- Bundling reference plugins in the installable extension artifact
- A security sandbox for user scripts
- A guarantee that an intentionally CPU-, memory-, or I/O-saturating child
  process cannot affect the rest of the system
- Direct measurement of GPU completion, KMS commit, page flip, or physical
  presentation from inside the extension

## 5. Current Workload Analysis

The source workload is `/home/jsn/workspace/argos-extensions`.

| Current plugin | Nominal cadence | Current work | Required replacement |
|---|---:|---|---|
| `01_cpu.1s.sh` | 1 s | Bash, `mpstat 1 1`, `jq`, `bc`, `printf`, `awk` | Consolidated `system-monitor` stream plugin |
| `02_mem.5s.sh` | 5 s | Bash, `free`, two `awk` executions | Consolidated `system-monitor` stream plugin |
| `03_hdd.1s.sh` | 1 s | Bash, `iostat 1 1`, two `kazy` executions, `awk` | Consolidated `system-monitor` stream plugin |
| `04_net.1s.sh` | 1 s | Bash, `ip`, `awk`, `mkdir`, six file/process operations, four `bc` executions | Consolidated `system-monitor` stream plugin |
| `10_dependabot.1h+.sh` | 1 h and menu open | `curl`, `jq`; conditionally hidden; one GitHub link | One-shot protocol plugin |
| `20_open_prs.5m+.sh` | 5 min and menu open | Four sequential GitHub requests, `jq`, `wc`; five links | One-shot protocol plugin |
| `30_nordvpn.5s.sh` | 5 s | `curl`, repeated `echo`, `head`, `tail`, two `jq` executions | One-shot protocol plugin |
| `40_weather.c.5m+.sh` | 5 min and menu open | `curl`, at least nine `jq` executions; center placement | One-shot protocol plugin |

Important behavior inferred from the scripts:

- CPU, memory, and disk percentages are padded to stabilize panel width.
- Network rates retain previous counters in `/tmp` and assume an exact interval.
- The disk device differs by host (`nvme0n1` or `nvme1n1`).
- Dependabot is hidden when its count is zero.
- Pull requests remain visible when the count is zero and expose several links.
- VPN is hidden when unprotected, visible with country details when protected,
  and displays an error state when its HTTP request fails.
- Weather appears in the center, uses a symbolic weather icon, and exposes
  location, temperature, apparent temperature, UV, rain text, and a rain
  timeline.
- A `+` filename suffix means refresh when the menu opens.

Specific correctness and efficiency issues to remove:

- Every `padded` helper invokes both `echo` and `awk` for formatting that GJS can
  do without another process.
- CPU and disk each start a second sampler (`mpstat` or `iostat`) and then start
  additional parsing processes. Their one-second waits are asynchronous from
  Argos's perspective, but the process creation, system counter walks, output
  ingestion, and later UI refresh still occur every cycle.
- Network selection runs `ip route get 8.8.8.8` on every update. The route rarely
  changes and should instead be event-driven or cached.
- Network rates divide counter deltas by an assumed one-second interval rather
  than the measured elapsed time. Delays, interface changes, and counter resets
  can therefore produce incorrect values.
- The GitHub scripts do not consistently fail on HTTP errors, have no complete
  pagination strategy, and the review script makes four requests sequentially.
- The VPN script parses the body before validating HTTP success and reparses one
  response through `head`, `tail`, `echo`, and multiple `jq` processes.
- Weather invokes `jq` repeatedly for fields that can be transformed in one
  pass. Its blank output lines are discarded by Argos and therefore do not
  reliably create the intended menu spacing.
- Each current plugin owns a separate Argos button. Completions can therefore
  cause multiple independent panel mutations instead of one atomic metrics
  update.

The high-frequency scripts currently optimize visual width but not execution.
The CPU and disk commands each perform their own one-second sampling window.
Argos starts the next interval only after completion, so their effective cadence
is longer than the filename suggests. The reference streaming sampler retains
counters in one long-running process and uses actual monotonic elapsed time,
eliminating this ambiguity.

Disabling Argos proves that Argos plus this workload triggers the frame-loss
pattern. It does not, by itself, distinguish subprocess contention from Argos's
main-thread parsing, actor reconstruction, garbage pressure, or the compositor
cost of the resulting repaint. The Phase 0 tests isolate those mechanisms before
the new implementation assumes one root cause.

## 6. Architecture

The extension is divided into the following modules:

```text
ExtensionController
  -> PluginRegistry
  -> RuntimeManager
       -> OneShotScheduler
       -> OneShotRunner
       -> StreamSupervisor
  -> StateStore
  -> RenderCoordinator
       -> PluginIndicator(s)
  -> Diagnostics
```

Responsibilities are strict:

- `ExtensionController` owns enable/disable and nothing else.
- `PluginRegistry` discovers, validates, adds, changes, and removes plugins.
- `RuntimeManager` owns one-shot deadlines and persistent stream processes.
- Plugin runtimes produce immutable semantic snapshots and never touch actors.
- `StateStore` compares snapshots and creates a minimal semantic change set.
- `RenderCoordinator` owns the single pending low-priority UI batch.
- Indicators own persistent actors and apply only changed properties.
- `Diagnostics` observes phases but does not own business logic.

No module may bypass `StateStore` to mutate visible state. The registry and
runtime are deliberately domain-agnostic: they interpret manifests and protocol
messages, not the meaning of displayed data. This makes no-op suppression
testable independently from GNOME Shell.

GObject subclasses MUST be limited to classes for which GNOME Shell requires a
registered GType. Plain JavaScript classes are preferred elsewhere.

### 6.1 Source Layout

The initial source tree is intentionally conventional and has no transpilation
or runtime dependency bundle:

```text
pico-argos@jsnjack.github.io/
  extension.js
  prefs.js
  metadata.json
  stylesheet.css
  lib/
    clock.js
    clock.test.js
    plugin-registry.js
    plugin-registry.test.js
    oneshot-runner.js
    oneshot-runner.test.js
    stream-runner.js
    stream-runner.test.js
    state.js
    state.test.js
    protocol.js
    protocol.test.js
    render.js
    render.test.js
    diagnostics.js
    diagnostics.test.js
  schemas/
    org.gnome.shell.extensions.pico-argos.gschema.xml
tests/
  fixtures/
  integration/
```

`extension.js` contains lifecycle wiring only. Parsing, scheduling, state
comparison, formatting, and histogram logic remain free of GNOME Shell UI
imports so they can run in ordinary GJS unit tests. Distributed JavaScript is
readable ES-module source, not minified output.

### 6.2 Execution Modes

All visible state originates in plugins. The core supports two modes because
their process-cost profiles differ:

- A `oneshot` plugin starts on a configured interval, emits one snapshot, and
  exits. This is appropriate for low-frequency network or command queries.
- A `stream` plugin is one persistent supervised process that emits
  newline-delimited protocol messages. This is appropriate for stateful or
  frequent sampling because it amortizes synchronous process creation and
  retains counters in the plugin.

The extension starts at most four streams. It serializes initial process
creation, supervises exit and heartbeat policy, applies exponential restart
backoff, and enforces line, message-rate, and byte-rate bounds. A stream is not a
daemon: the extension owns its direct child for the enabled generation and
terminates it during disable or plugin replacement.

Reference plugins live in the source repository outside the extension UUID
directory and are installed explicitly. They use only the public manifest and
output protocol and MUST NOT import extension internals.

## 7. Reference System Monitor Stream Plugin

CPU, GPU, memory, disk, and network metrics are implemented by one optional
`system-monitor` stream plugin. The plugin is distributed separately from the
extension artifact, uses only the public plugin contract, and MUST NOT spawn
external commands on each sample.

The maintained reference implementation is a GJS executable started as
`["gjs", "-m", "./run.js"]`. This keeps the project source-only and avoids a
compiled companion daemon. The protocol remains language-neutral, so users may
replace it with a Go, Rust, Python, or other implementation without changing
the extension.

### 7.1 Sampling

- CPU, GPU, and network counters are sampled every 250 ms by default.
- Disk counters are sampled every 500 ms by default.
- Memory is sampled every 1,000 ms by default.
- One monotonic scheduler drives all five cadences. It wakes at the earliest due
  deadline and reads only the sources due in that cycle.
- The reference plugin MAY synchronously read bounded `/proc` and `/sys` files
  because it executes outside GNOME Shell. It SHOULD open each stable path once,
  seek to the beginning for each sample, and reopen only after a read, seek,
  device, or interface failure. No sample reads more than 64 KiB in total.
- A new sampling cycle starts from a monotonic deadline, not from the completion
  time of the previous cycle.
- Missed deadlines are skipped; they are never replayed in a burst.
- At most one sampling cycle is active.
- Results from one cycle are combined with the most recent slower fields and
  committed atomically to one semantic snapshot.
- Baseline and memory reads happen immediately at startup. The first rate-bearing
  snapshot is emitted after the first 250-ms fast interval.
- The plugin compares its fully formatted snapshot with the last emitted
  snapshot. It emits no snapshot when visible state is identical and emits a
  heartbeat after two seconds without a snapshot.

The fast interval is configurable from 100 through 2,000 ms, but 250 ms is the
required default. This provides four opportunities per second for fresh CPU and
network data without tying work to the 120-Hz compositor frame rate. The system
plugin manifest sets `maxMessagesPerSecond` to `5`, `startupTimeoutMs` to
`2,000`, and `heartbeatTimeoutMs` to `5,000`. The protocol hard ceiling of 10
messages per stream and the global ceiling of 10 UI batches per second remain
unchanged.

For a changed CPU or network value under normal load, the time from scheduled
sample deadline to completed UI apply MUST have p95 at or below 350 ms and MUST
NOT exceed 750 ms. Sampling delay, plugin formatting, pipe delivery, protocol
processing, idle-queue delay, and actor mutation are reported separately.

### 7.2 CPU

The plugin reads the aggregate `cpu` line from `/proc/stat`.

```text
idle_all = idle + iowait
non_idle = user + nice + system + irq + softirq + steal
total = idle_all + non_idle
usage = 100 * delta(total - idle_all) / delta(total)
```

Guest fields are not added because they are already represented in user/nice
accounting. Negative, zero, malformed, or reset deltas invalidate only the
current CPU sample. Linux documents `iowait` as imperfect and occasionally
decreasing; the plugin MUST treat this metric as an estimate rather than an
exact utilization measurement.

### 7.3 GPU

The plugin reads the kernel DRM `gpu_busy_percent` counter from
`/sys/class/drm/<card>/device/gpu_busy_percent`, an already-normalized
percentage that requires no delta computation.

The DRM card is selected by plugin configuration through `gpuDevice`, with
`auto` as the default. Auto resolution enumerates `/sys/class/drm/card[0-9]*`
entries (`renderD*` nodes never match and are excluded), prefers the boot VGA
card among those exposing a readable `gpu_busy_percent` file, and otherwise
falls back to the lowest-numbered card that exposes it. Resolution MUST NOT
poll by spawning `lspci`, `nvidia-smi`, or another external command. If no
card exposes the counter, the field shows the fixed-width unavailable
placeholder and emits a stable snapshot rather than retrying every cycle.

When `gpuDevice` is `auto`, the plugin watches `/sys/class/drm` and
re-resolves the selected card on any change, closing and reopening its reader
only when the resolved card actually differs. An explicit `cardN` value is
used as configured and is never re-resolved; if that path stops exposing the
counter, the field reports unavailable until the process restarts. GPU
utilization shares the 250-ms fast cadence with CPU and network so the field
never appears staler than CPU on the same panel.

### 7.4 Memory

The plugin reads `/proc/meminfo` and computes:

```text
used = MemTotal - MemAvailable
usage = 100 * used / MemTotal
```

`MemAvailable` is required. The plugin MUST NOT substitute `MemFree`, because
that would count readily reclaimable cache as unavailable memory.

### 7.5 Disk

The block device is selected by plugin configuration, with `auto` as the
default. Version 1 MUST support an explicit device because root filesystems may
involve device mapper, encryption, RAID, or multiple NVMe devices.

For a direct block device, the plugin reads `/sys/block/<device>/stat` and
uses field 10, milliseconds spent doing I/O:

```text
utilization = 100 * delta(io_milliseconds) / elapsed_monotonic_milliseconds
```

The displayed value is clamped to `[0, 100]`. This is an activity estimate, not
a universal saturation metric. Modern multiqueue devices can perform concurrent
I/O, and kernel accounting granularity can undercount some intervals.

`auto` resolution MUST be cached and recomputed only after a mount or device
change. If reliable resolution is not possible, the disk field shows
unavailable and emits a stable unavailable snapshot; it MUST NOT poll by
spawning `findmnt`, `lsblk`, or `iostat`.

### 7.6 Network

The plugin determines the primary interface using NetworkManager D-Bus when
available. It falls back to an explicit configured interface, then to the IPv4
default route in `/proc/net/route`. It MUST NOT execute `ip route` every second.

The plugin reads one `/proc/net/dev` snapshot and extracts receive and
transmit byte counters for the selected interface. Rates use actual elapsed
monotonic time:

```text
rx_bytes_per_second = delta(rx_bytes) / elapsed_seconds
tx_bytes_per_second = delta(tx_bytes) / elapsed_seconds
```

An interface change, counter decrease, suspend/resume discontinuity, or elapsed
time outside `[0.5 * fastInterval, 4 * fastInterval]` resets the baseline. The
first sample after a reset displays zero rather than a false spike.

Rates use SI units (`kB/s`, `MB/s`, `GB/s`) because the current scripts divide
by powers of 1,000.

### 7.7 System Panel Rendering

All five metrics are rendered in one persistent `St.Label`. The string has
fixed-width fields and uses a compact monospace style, for example:

```text
cpu  12% gpu  34% mem  47% io   0% rx  123.4K tx    2.1M
```

The formatter MUST keep the number of characters constant across ordinary
values and unit transitions. Overflow is clamped to the largest representable
field. The containing actor has a stable width and allocation.

One combined label deliberately replaces four independently updating Argos
buttons. This reduces process launches, panel layout changes, property writes,
and opportunities to trigger separate compositor frames.

### 7.8 Plugin Configuration

Field selection, GPU device, disk device, network interface, and sampling
intervals belong to the reference plugin's own configuration. Its defaults are
250 ms for CPU, GPU, and network, 500 ms for disk, and 1,000 ms for memory. The
extension neither defines nor parses those domain-specific values. Position,
order, process limits, and failure behavior remain in the universal manifest.

The extension's GSettings schema is
`org.gnome.shell.extensions.pico-argos` and contains two persistent settings:

| Key | Type | Default | Constraint |
|---|---|---|---|
| `diagnostics-mode` | `s` | `summary` | `summary` or `off`; trace is transient |
| `disabled-plugins` | `as` | `[]` | Validated discovered plugin identifiers to keep stopped and unrendered |

## 8. Universal Plugin Model

All integrations are trusted user executables, but their output is treated as
untrusted data at the GNOME Shell stability boundary.

### 8.1 Layout

Plugins are directories under:

```text
$XDG_CONFIG_HOME/pico-argos/plugins/<plugin-id>/
  plugin.json
  run
```

`run` may be any executable with a valid shebang. The installable extension
distribution contains no executable plugins.

### 8.2 Manifest

Example:

```json
{
  "manifestVersion": 1,
  "id": "vpn",
  "mode": "oneshot",
  "command": ["./run"],
  "intervalMs": 5000,
  "timeoutMs": 4000,
  "refreshOnOpen": false,
  "position": "right",
  "order": 30,
  "passEnvironment": [],
  "failurePolicy": "keep-last",
  "maxStaleMs": 30000
}
```

Manifest rules:

- `manifestVersion` MUST equal `1`.
- `id` MUST match `[a-z0-9][a-z0-9._-]{0,63}` and the directory name.
- `mode` MUST be `oneshot` or `stream`.
- `command` MUST be a non-empty argv array. No shell splitting is performed.
- `command` contains at most 32 elements, each at most 4,096 UTF-8 bytes, with
  at most 16 KiB total encoded size.
- An executable containing `/` is resolved relative to the plugin directory and
  MUST remain inside it after path normalization. A bare executable name is
  resolved only through the child process's minimal `PATH`.
- For `oneshot`, `intervalMs` MUST be between 1,000 and 86,400,000;
  `timeoutMs` MUST be between 100 and 30,000 and less than `intervalMs`; and
  `refreshOnOpen` is boolean.
- For `stream`, `startupTimeoutMs` defaults to 5,000 and is between 100 and
  30,000; `heartbeatTimeoutMs` defaults to `0` (disabled) and is either `0` or
  1,000 through 300,000; `maxMessagesPerSecond` defaults to `2` and is 1 through
  10; and `maxBytesPerMinute` defaults to 262,144 and is 65,536 through
  1,048,576. One-shot-only fields are rejected.
- `position` is `left`, `center`, or `right`.
- `order` is an integer. Ordering is `(position, order, id)`.
- `nice` is `null` or an integer from 0 through 19 and defaults to `10`.
  `null` disables the niceness wrapper. If the host cannot apply the requested
  niceness, the process still runs and diagnostics record that mitigation as
  unavailable.
- `reserveTextChars` is an optional integer from 0 through 128. A nonzero value
  reserves a stable monospace text allocation and output longer than the value
  is rejected. It is a layout limit, not a request for truncation.
- `passEnvironment` explicitly allowlists inherited variable names. Environment
  values are never recorded in diagnostics.
- `passEnvironment` contains at most 16 unique names matching
  `[A-Za-z_][A-Za-z0-9_]*`.
- `passEnvironment` MUST NOT name the fixed `HOME`, `PATH`, locale, XDG, or
  `PICO_ARGOS_*` variables supplied by the runtime.
- `failurePolicy` is `keep-last`, `hide`, or `show-error`.
- `maxStaleMs` is a positive integer no larger than 604,800,000, or `null` to
  disable visual staleness. For one-shot plugins it MUST be at least
  `intervalMs`.
- Unknown manifest keys are rejected in version 1 to catch misspellings.

The child receives a minimal environment containing `HOME`, `PATH`, `LANG`,
`LC_ALL`, the XDG directory variables, allowlisted variables, and:

```text
PICO_ARGOS_PROTOCOL=1
PICO_ARGOS_MENU_OPEN=true|false  # one-shot only
PICO_ARGOS_PLUGIN_ID=<id>
```

### 8.3 Output Protocol

A snapshot is one UTF-8 JSON object. A one-shot plugin writes exactly one JSON
document and exits with status zero. A stream plugin writes one compact JSON
object per line and flushes each line; partial lines are buffered only up to
64 KiB. Logging belongs on stderr.

Example:

```json
{
  "version": 1,
  "type": "snapshot",
  "panel": {
    "visible": true,
    "text": "2",
    "icon": "software-update-available-symbolic",
    "appearance": "compact",
    "accessibleName": "Two critical dependency alerts",
    "severity": "critical"
  },
  "menu": [
    {
      "id": "alerts",
      "kind": "link",
      "text": "View critical alerts",
      "uri": "https://github.com/example/project/security/dependabot"
    }
  ]
}
```

Top-level rules:

- `version` MUST equal `1`.
- `type` MUST equal `snapshot` for visible state.
- `panel` is an object or `null`. `null` hides the indicator.
- `menu` is an array with at most 64 entries.
- Unknown fields are rejected.
- A one-shot document or one stream line MUST be at most 64 KiB including its
  terminating newline where present.
- JSON nesting MUST NOT exceed the schema's fixed nesting.

Panel rules:

- `visible` is boolean and defaults to true.
- At least one of `text` or `icon` is required when visible.
- `text` is plain UTF-8 text, at most 128 Unicode scalar values.
- Panel text contains no newline or control character.
- `icon` is a GNOME icon-theme name matching
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
- `appearance` is `compact`, `monospace`, or `normal`.
- `severity` is `normal`, `warning`, or `critical`.
- `accessibleName` is required if text alone does not explain the state.
- Markup is never interpreted.

Menu entries have stable unique IDs and one of these forms:

```json
{"id":"country","kind":"label","text":"Connected to NL"}
{"id":"sep-1","kind":"separator"}
{"id":"reviews","kind":"link","text":"Review requested","uri":"https://github.com/pulls/review-requested"}
```

Menu rules:

- IDs are required and unique within the snapshot.
- Label and link text is plain text, at most 512 Unicode scalar values.
- Menu text contains no control characters. Newlines are not supported in
  version 1; separate label or separator items are used instead.
- Version 1 accepts only `https` URIs.
- URIs are at most 2,048 UTF-8 bytes and must parse successfully with `GLib.Uri`.
- Links are opened with `Gio.AppInfo.launch_default_for_uri()`.
- Labels are not interactive.
- Empty labels are rejected; separators represent visual grouping.
- Plugins cannot provide callbacks, JavaScript, shell commands, CSS, or markup.

A stream may also emit a heartbeat:

```json
{"version":1,"type":"heartbeat"}
```

Heartbeats reset the configured liveness deadline but do not enter
`StateStore`, queue UI work, or count as snapshots. They contain no other
fields. Stream stdout is governed by two token buckets: all complete protocol
messages per second and total bytes per minute. Heartbeats consume both budgets.
Crossing either limit terminates the process and enters restart backoff. Stream
stderr is retained in an 8-KiB rolling tail; more than 64 KiB in one minute also
terminates the process.

Each bucket starts full. The message bucket capacity equals
`maxMessagesPerSecond` and refills continuously at that many tokens per second;
each complete line costs one token. The byte bucket capacity equals
`maxBytesPerMinute` and refills continuously at one-sixtieth of that value per
second; every stdout byte costs one token as it is read. Fractional tokens are
allowed, and elapsed time is monotonic. Limits are checked before parsing a
complete line.

### 8.4 Failure Semantics

A run or stream fails on timeout, unexpected exit, signal, nonzero exit, invalid
UTF-8, oversized output, rate-limit breach, invalid JSON, or schema violation.

- `keep-last` retains the last valid snapshot without mutating actors.
- `hide` hides the indicator once per transition into failure.
- `show-error` changes to one stable error state once per transition.
- Repeated identical failures do not cause repeated UI writes.
- Staleness is evaluated on state transitions and coarse scheduler ticks; it is
  not implemented as an on-screen seconds counter.
- Stderr is retained only for the latest failure, capped at 8 KiB, and excluded
  from exported diagnostics unless the user explicitly opts in.
- Stream restarts use delays of 1, 2, 4, 8, 16, 32, then 60 seconds. The delay
  remains capped at 60 seconds and resets only after five healthy minutes.
- After ten consecutive failed starts, the stream remains stopped until its
  manifest changes, the extension is re-enabled, or the user explicitly
  restarts it. This prevents permanent restart storms.

## 9. Runtime Scheduling and Subprocess Execution

The one-shot scheduler uses `GLib.get_monotonic_time()` and one timer for all
one-shot plugins. At most 16 total plugins are loaded, at most one one-shot child
runs globally, and at most four supervised stream children coexist. A due
one-shot plugin waits in a bounded queue; user-requested `refreshOnOpen` work
has priority over periodic work but does not preempt an active child.

The queue contains at most one pending token per one-shot plugin and therefore
at most 16 entries. Repeated due or menu-open events coalesce into that token.
Within each priority class, the earliest scheduled deadline runs first; a
plugin cannot run twice while another plugin of the same class remains pending.

For each one-shot plugin:

1. `nextDue` is based on the previous scheduled deadline, not completion time.
2. If the process is still running at `nextDue`, the occurrence is counted as
   skipped; no second process starts.
3. After a missed deadline or resume from suspend, the next future deadline is
   selected. There is no catch-up burst.
4. Initial deadlines are deterministically phased by plugin ID so unrelated
   network plugins do not all fork simultaneously.
5. `refreshOnOpen` requests one immediate refresh. Requests are coalesced while
   a run is active.

Subprocess requirements:

- Use `Gio.SubprocessLauncher` and argv, never a shell command line.
- Capture stdout and stderr through separate pipes and drain both concurrently.
- Read bounded chunks asynchronously; `communicate_utf8_async()` MUST NOT be
  used because it collects unbounded output before returning.
- One-shot stdout is retained as at most eight 8-KiB chunks, combined once, and
  decoded once. After exactly 64 KiB, one bounded probe read distinguishes EOF
  from overflow. Repeated string concatenation is forbidden.
- If one-shot stdout crosses 64 KiB or stderr crosses 8 KiB, terminate the run
  immediately. Both pipes are drained concurrently until termination so one
  full pipe cannot deadlock the child.
- Use one `Gio.Cancellable` per run.
- On timeout or shutdown, send `SIGTERM` to the direct child, allow at most 250
  ms for exit, then call `force_exit()`. Cancelled reads remain guarded by the
  generation token.
- The direct child MUST be reaped on every path.
- Scripts MUST NOT daemonize or leave grandchildren. `force_exit()` does not
  guarantee termination of an independently running grandchild.
- A disabled or removed plugin cancels its timer, reads, and direct child.
- Completion after disable may update diagnostics but MUST NOT touch actors.

For stream plugins, stdout is decoded incrementally with one persistent decoder
so a multibyte UTF-8 sequence may cross read boundaries. Complete lines are
removed from a bounded byte buffer, parsed once, and discarded. The runner MUST
not retain the stream history. Only the last raw snapshot, last valid semantic
snapshot, partial line, fixed counters, and bounded stderr tail remain.

Stream startup is successful only after the first valid snapshot arrives before
`startupTimeoutMs`. A configured heartbeat deadline is measured from the last
valid snapshot or heartbeat. Unexpected exit, startup timeout, heartbeat
timeout, or a protocol limit breach enters the backoff in Section 8.4. Stream
starts and restarts are serialized so several synchronous spawn calls cannot
land in one main-loop turn.

Creating a `Gio.Subprocess` is itself a synchronous call on the Shell main
thread even though waiting and pipe I/O are asynchronous. `launch_begin` to
`spawn_return` therefore remains part of the compositor-critical budget. This
is why high-frequency integrations use persistent streams and one-shot launch
cadence is minimized. If spawn-call timing repeatedly violates Section 3, the
plugin SHOULD move from one-shot to stream mode; the threshold is not waived.

Where available, user plugins SHOULD run with CPU niceness 10. This is a
mitigation for system-wide contention, not a substitute for bounded execution.
It MUST be possible to disable niceness per plugin for correctness-sensitive
commands.

## 10. State Comparison and Rendering

### 10.1 Raw and Semantic Comparison

The runtime retains the last valid raw snapshot string per plugin. For one-shot
plugins this is the complete stdout document; for streams it is only the most
recent complete snapshot line. Heartbeats bypass snapshot comparison.

- Identical raw output stops before `JSON.parse()`.
- Changed output is parsed and validated once.
- The semantic snapshot is compared by explicit fields, not by serializing it
  again.
- A changed timestamp or irrelevant JSON whitespace therefore causes parsing
  but no actor mutation.
- Plugins SHOULD omit volatile fields that do not affect presentation.

### 10.2 UI Batching

`RenderCoordinator` owns at most one pending
`GLib.PRIORITY_DEFAULT_IDLE` source. Plugin changes merge into its pending
change set. One callback applies all pending leaf-property changes.

The renderer MUST count:

- label text writes
- icon-name writes
- visibility writes
- style-class writes
- menu property writes
- actor creations and destructions

These counters are part of release tests and diagnostics.

### 10.3 Persistent Indicators

Each indicator creates when its plugin is accepted:

- one `PanelMenu.Button`
- one fixed container
- one persistent `St.Icon`, initially hidden if unused
- one persistent `St.Label`, initially hidden if unused

Normal updates change only values whose semantic fields differ. Children are
never removed and re-added during a refresh. Style classes come from a fixed
extension-owned set.

Plugins using `appearance: "monospace"` and nonzero `reserveTextChars` receive
a stable allocation derived from that limit. Other indicators use stable
minimum/maximum dimensions where their content permits it. No animation is used
for periodic data changes.

### 10.4 Menus

- Menu snapshots are retained as plain data while closed.
- No menu actors are created until first open.
- After first open, actors are retained and keyed by item ID.
- Opening applies the latest snapshot before display.
- Opening never waits for a `refreshOnOpen` execution. It displays the cached
  valid snapshot immediately and applies the eventual result asynchronously.
- While open, item text, URI, visibility, and severity are updated in place.
- Reordering moves existing actors; it does not recreate them.
- Removed item actors are destroyed only when the semantic item is actually
  removed.
- The permanent diagnostics/edit affordances are created once, not per refresh.

## 11. Plugin Directory Monitoring

Directory monitors may emit several events for one editor save. The registry
MUST debounce for 250 ms before doing any work.

- Only the affected plugin is revalidated.
- Existing UI remains until a complete replacement manifest validates.
- An invalid replacement records an error and keeps the working plugin.
- Adding one plugin does not rebuild existing indicators.
- Removing one plugin destroys only that plugin after the debounce window.
- Changes to unrelated temporary files are ignored.
- Enumeration and manifest reads are asynchronous.

## 12. Diagnostics and Timing

Performance observability is a product feature. It has three modes:

| Mode | Behavior |
|---|---|
| `summary` | Default; bounded counters and histograms, no per-update logging |
| `trace` | Time-limited per-cycle events plus optional stage timing hooks |
| `off` | Errors only; intended for comparison measurements |

The persistent GSettings key `diagnostics-mode` accepts `summary` or `off` and
defaults to `summary`. `trace` is a transient overlay started through the
diagnostic interface; when it ends, the extension returns to the persistent
mode.

### 12.1 Clock and Correlation

Every accepted snapshot receives a monotonically increasing `cycleId`. Every
one-shot invocation and stream process lifetime receives a `runId`; stream
messages additionally receive a per-run sequence number. All timing uses
`GLib.get_monotonic_time()` in microseconds.

A trace records paired realtime and monotonic timestamps at start and end. This
allows correlation with journald. Monotonic timestamps also align with kernel
and bpftrace captures based on `bpf_ktime_get_ns()` after unit conversion.

### 12.2 Measured Phases

Every cycle records, where applicable:

```text
scheduled_due
scheduler_callback_begin
launch_begin
spawn_return
first_stdout_byte
stream_first_snapshot
stream_line_complete
stream_heartbeat
stream_restart_scheduled
stdout_eof
stderr_eof
process_exit
decode_begin / decode_end
raw_compare_end
parse_begin / parse_end
validate_end
semantic_diff_end
ui_queued
ui_apply_begin / ui_apply_end
```

Derived measurements include:

- scheduler lateness
- spawn-call duration
- child wall time
- time to first byte
- pipe-drain duration
- stdout/stderr byte counts
- stream uptime, message rate, byte rate, heartbeat age, restart count, and
  current backoff
- decode, parse, validation, and diff durations
- UI queue wait and apply duration
- changed versus raw-no-op versus semantic-no-op
- skipped, timed-out, rejected, and failed runs
- actor property writes, creations, and destructions
- current and peak concurrent child count

Histograms use fixed microsecond buckets:

```text
10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, +Inf
```

Summary mode stores count, sum, minimum, maximum, buckets, and the most recent
violation. It does not retain every cycle and does not log ordinary updates.
Displayed percentiles are bucket upper bounds, not invented precision.

The trace ring contains at most 16,384 fixed-size numeric event slots. Summary
histograms and the trace ring are allocated once when their mode starts; they do
not grow in response to plugin activity.

### 12.3 Stage Timing

Trace mode MAY connect temporarily to available `Clutter.Stage` signals such as
`before-update`, `before-paint`, `after-paint`, and `presented`.

- Hooks are feature-detected and version-gated.
- Stage capture is armed only after a UI batch performs at least one actor
  property write. It observes the following stage cycle for each view, then
  disarms no later than 100 ms after `ui_apply_end`.
- Hooks are disconnected while disarmed and automatically at trace end. The
  extension MUST NOT collect every frame throughout a 60-second trace.
- Signal callbacks write only numeric timestamps and identifiers to a bounded
  preallocated ring.
- They do not stringify data, log, inspect actors, or update UI.
- The first stage cycle after `ui_apply_end` is correlated with the changed UI
  batch and each affected stage view/monitor.

Stage signals reveal Shell-side update and paint timing. They do not prove GPU
fence completion, KMS readiness, page-flip dispatch, or physical presentation.
Those require Mutter debug logs, Sysprof, DRM tracepoints, or bpftrace. The
diagnostic export MUST state this boundary rather than labelling stage timing as
KMS timing.

### 12.4 Trace Storage and Export

- Trace mode defaults to 60 seconds and is capped at 10 minutes.
- The event ring has a fixed maximum capacity. Overflow increments a dropped
  event counter instead of allocating more memory.
- Per-update journal logging is forbidden.
- Slow-phase warnings are rate-limited to one per plugin per minute.
- Trace completion writes one JSON file under
  `$XDG_CACHE_HOME/pico-argos/diagnostics/`.
- Export serialization is deferred until tracing has stopped and is divided
  across low-priority idle slices, each constrained by the ordinary synchronous
  phase budget. The final file write is asynchronous.
- Export contains GNOME Shell/GJS versions, extension version, monitor layout,
  refresh rates, sanitized manifests, aggregates, trace events, and mutation
  counters.
- Export excludes environment values, authorization data, stdout content,
  stderr content by default, and URI query strings.
- Output hashes may be recorded for change correlation.

### 12.5 Diagnostic Control Interface

The enabled extension owns this session-bus interface:

```text
bus name:    org.gnome.Shell.Extensions.PicoArgos
object path: /org/gnome/Shell/Extensions/PicoArgos
interface:   org.gnome.Shell.Extensions.PicoArgos.Diagnostics1
```

Version 1 methods and signals are:

```text
GetSummary() -> (s json)
StartTrace(u durationSeconds) -> (u traceId)
StopTrace() -> ()
ResetSummary() -> ()
TraceReady(u traceId, s path)
```

`GetSummary()` returns a sanitized document capped at 64 KiB. Building it is a
measured phase and it MUST meet the ordinary synchronous phase budget. Control
methods only change diagnostic state; export is performed through the bounded
path in Section 12.4. `StartTrace()` accepts 1 through 600 seconds and returns a
busy error if a trace or export is already active. The interface is removed
during `disable()`.

### 12.6 Easy Diagnostic Controls

The preferences process provides a Diagnostics page with:

- plugin health, mode, process state, and last successful update
- last failure category
- child runtime and phase p50/p95/p99/max
- bytes, message rate, no-op rate, skipped runs, restarts, backoff, timeouts, and
  output rejections
- actor mutation counters
- `Record 30 s`, `Record 60 s`, `Stop`, `Export`, and `Reset` controls

The diagnostics view is populated only while open and MUST NOT create a
continuously repainting panel indicator.

Headless capture uses `gdbus` without installing a separate CLI:

```sh
gdbus call --session \
  --dest org.gnome.Shell.Extensions.PicoArgos \
  --object-path /org/gnome/Shell/Extensions/PicoArgos \
  --method org.gnome.Shell.Extensions.PicoArgos.Diagnostics1.StartTrace 60
```

After the duration, the extension returns to `summary`, exports automatically,
emits `TraceReady`, and writes one rate-limited journal message containing the
export path.

## 13. Migration of Current Integrations

### 13.1 System Metrics

The four local scripts are replaced by one maintained `system-monitor` stream
plugin. It emits one combined fixed-width snapshot per second and retains all
counter baselines in its own process.

Benefits:

- zero recurring process launches; one process is started when the plugin starts
- one counter snapshot instead of `mpstat` and `iostat` sampling processes
- one combined actor instead of four independent buttons
- actual elapsed-time rate calculations
- no `/tmp` state files
- no `jq`, `bc`, `awk`, `kazy`, `free`, `ip`, `cat`, or shell pipelines

The configured disk override MUST support the existing host mapping during
migration. Each host stores its resolved or explicit device in the plugin's own
configuration, not extension GSettings.

### 13.2 Dependabot

Required behavior:

- Refresh hourly and when its menu opens.
- Show the critical open-alert count only when nonzero.
- Use a critical severity style.
- Expose one HTTPS link to the repository's critical Dependabot alerts.
- Retain the last valid value on transient network failure.

The migrated plugin performs one HTTP request and one JSON transformation. It
outputs a single protocol document and does not use emoji-name expansion.

### 13.3 Pull Request Reviews

Required behavior:

- Refresh every five minutes and when its menu opens.
- Count non-draft pull requests requesting review from the configured user
  across the configured repositories.
- Remain visible in an explicit all-clear state when the count is zero.
- Provide links for review requests, reviewed pull requests, assigned issues,
  authored pull requests, and new issues.

The migration SHOULD replace four sequential REST calls with one GitHub GraphQL
request or concurrent bounded requests. It MUST parse once and emit one JSON
document.

### 13.4 VPN

Required behavior:

- Refresh every five seconds with a four-second timeout.
- Hide when the service reports that the public IP is unprotected.
- Show a stable symbolic protection icon when protected.
- Show the country code in the menu.
- Keep the last valid state on a transient failure; expose failure in
  diagnostics rather than repainting an ellipsis every five seconds.

The script parses the HTTP response once. HTTP status is handled by the command
exit status, not appended to stdout and reparsed with `head` and `tail`.

### 13.5 Weather

Required behavior:

- Position in the center.
- Refresh every five minutes and when opened.
- Show current temperature, rain-intensity indicator, and a symbolic condition
  icon.
- Menu contains location, current/apparent temperature, two-hour temperature,
  UV index, rain description, and nonzero rain timeline entries.
- Preserve the last valid forecast on transient failure.

The migrated script invokes `jq` once to transform the response directly into
the protocol document. Blank output lines are replaced by explicit separator
items. Images and markup are unnecessary.

### 13.6 Reference Plugin Rules

Migrated network scripts MUST:

- use `curl --fail --silent --show-error` or an equivalent client
- set connection and total deadlines below the manifest timeout
- send protocol JSON only to stdout
- send errors only to stderr and exit nonzero
- parse a response once rather than repeatedly piping it through `jq`
- avoid sequential requests when one request or bounded concurrency works
- never include access tokens in argv, stdout, stderr, or diagnostic data

## 14. Error Handling and User Experience

- One plugin failure never affects another plugin.
- A malformed plugin never removes or reconstructs unrelated UI.
- Errors are state transitions, not animations.
- Repeated errors update counters without repainting the same error state.
- Last-known values may be marked stale through a fixed style change, applied
  once.
- Detailed error text belongs in preferences/diagnostics, not the panel.
- Enabling the extension with no plugins succeeds and performs no periodic
  work.
- A reference plugin may represent an unavailable metric inside its own stable
  text without requiring any core behavior.

## 15. Security and Privacy

- Plugin executables are trusted code running as the user. Output validation is
  a Shell-stability boundary, not a security sandbox.
- Commands are argv arrays; the extension never invokes `bash -c`.
- Plugin-provided URIs are restricted to HTTPS in version 1.
- Text is plain and never interpreted as markup.
- Environment inheritance is allowlisted.
- Secret values never appear in logs, settings exports, diagnostic exports, or
  panel accessibility text.
- Config and plugin files must be owned by the current user and must not be
  group/world writable unless an explicit unsafe-development setting is active.
- The extension performs no privileged operations.

## 16. Lifecycle Requirements

`enable()` creates plugin runtimes, actors, settings handlers, directory
monitors, and scheduler sources. `disable()` MUST deterministically:

1. prevent new work
2. remove timer and idle sources
3. disconnect stage, settings, directory, network, and menu signals
4. cancel reads and terminate direct children
5. destroy indicators and menus
6. clear retained models and diagnostic buffers

Late asynchronous callbacks check a generation token before doing any work.
Re-enable creates a new generation. No source ID, signal handler, actor, child,
or closure from the old generation may survive.

The default session mode is `user`. Lock-screen operation is not supported.

## 17. Testing Strategy

### 17.1 Unit Tests

Pure modules are tested outside GNOME Shell with GJS:

- manifest validation
- protocol validation
- raw and semantic no-op detection
- scheduler deadlines, skips, resume behavior, and refresh-on-open coalescing
- stream framing, UTF-8 boundary handling, rate budgets, liveness, restart
  backoff, and failed-start lockout
- failure policies and staleness transitions
- histogram and trace-ring bounds

The scheduler and runtimes receive an injected clock in tests. Reference plugin
tests separately cover CPU, GPU, memory, disk, and network parsing; counter
wrap/reset; elapsed-time handling; and fixed-width formatting. Those tests MUST
use only the public protocol contract.

### 17.2 Runner Fixtures

Fixtures cover:

- constant output
- changing one-line output
- slow output in chunks
- exactly 64 KiB and over-limit output
- stderr flooding
- invalid UTF-8
- invalid JSON and unknown fields
- nonzero exit
- timeout
- child finishing during disable
- rapid plugin file replacement
- stream snapshots split across arbitrary byte boundaries
- multiple messages in one read and a partial final line
- heartbeat timeout, message-rate flood, byte-rate flood, crash loop, and healthy
  restart-backoff reset

### 17.3 Actor Tests

Mutation counters are assertions:

- 10,000 identical refreshes produce zero property writes after initialization.
- 10,000 changing text refreshes produce no actor creation or destruction.
- Closed menus produce no menu actors before first open.
- Reopening an unchanged menu produces no mutation.
- Updating one menu label changes one existing label property.
- Adding/removing one plugin does not mutate other plugins.

### 17.4 GNOME Integration

GNOME 50 integration tests run in a nested Wayland Shell using Mutter devkit.
They verify enable/disable cycles, placement, menu links, settings, directory
reload, actor counts, and absence of critical log messages.

### 17.5 Frame-Latency Acceptance

Final performance testing runs on the affected dual-120-Hz AMD laptop in the
same power profile and display configuration.

Each scenario has at least five interleaved baseline and enabled runs:

1. Extension disabled.
2. Extension enabled with no plugins.
3. Constant stream plugin at 250-ms cadence.
4. Same-width changing stream plugin at 250-ms cadence.
5. One-shot plugin at one-second cadence.
6. Full migrated workload.

Primary acceptance runs use default `summary` diagnostics and are repeated with
diagnostics `off` to quantify always-on measurement cost. Separate `trace` runs
provide stage/Mutter/kernel correlation. Trace runs are not substituted for the
primary performance result, because stage hooks and event recording can perturb
timing.

Capture simultaneously:

- a continuous Wayland presentation-feedback/frame-callback client
- extension summary snapshot or diagnostic trace, according to run mode
- GNOME Shell/Mutter frame timing where available
- KMS-ready and presentation timing where available
- CPU usage, process launches, and wakeups

`weston-simple-timing` MUST NOT be treated as an FPS test; its scheduled commit
pattern does not represent continuous frame callbacks.

Release criteria:

- Constant output has zero update-correlated stage mutation after initialization.
- Enabling an empty extension is statistically indistinguishable from baseline.
- No scenario introduces a recurring cluster of long presentation intervals
  correlated with plugin cycles. On a VRR/Adaptive-Sync-capable display this
  clustering signal is structurally unavailable per Section 18 item 19; the
  delivered-frame-rate criterion below remains the authoritative gate on such
  hardware.
- Full workload changes average delivered frame rate by no more than 0.1% versus
  interleaved baseline, with confidence intervals reported.
- No extension phase exceeds the release-failure thresholds in Section 3 under
  valid bounded input.
- GNOME Shell actor count and retained memory reach steady state; after warmup,
  one hour of operation shows no monotonic growth attributable to refreshes.

## 18. Known Limitations and Gotchas

1. Extension JavaScript executes in GNOME Shell's main context. Async GIO avoids
   waiting there, but completion callbacks still execute there.
2. JavaScript cannot be preempted midway through a bad parser or renderer. Input
   bounds and small synchronous phases are the protection.
3. Any visible text change necessarily causes a repaint. If the underlying
   Mutter/amdgpu problem is triggered by every panel repaint, the extension can
   reduce frequency but cannot fix the lower layer.
4. External processes compete for CPU, cache, memory bandwidth, and I/O even
   when spawned asynchronously and with lower priority.
5. Killing a `Gio.Subprocess` direct child does not reliably kill detached
   grandchildren. Plugins must not daemonize.
6. `/proc` and `/sys` make the reference system plugin Linux-specific.
7. CPU utilization and disk utilization are estimates based on kernel counters;
   their semantics are not identical to resource saturation.
8. Default-interface selection is ambiguous with VPNs, policy routing,
   containers, and simultaneous wired/wireless links. Explicit configuration is
   authoritative.
9. Device-mapper and encrypted root filesystems can make automatic block-device
   selection misleading.
10. Suspend/resume and counter resets discard one rate sample by design.
11. First menu open may create up to 64 actors. This is bounded but not free;
    timing is recorded separately.
12. Stage `presented` and related signal details may change across GNOME Shell
    releases. They are diagnostic enhancements, not runtime dependencies.
13. GNOME Shell extensions cannot directly observe KMS-ready fences or hardware
    page flips through a stable public API.
14. Extension code changes require a Shell reload; on Wayland this normally
    means a nested development session or logout/login.
15. The GNOME Extensions review process discourages spawning arbitrary external
    scripts. Distribution through extensions.gnome.org is not assumed until the
    design has been reviewed with GNOME maintainers.
16. `Gio.Subprocess` creation is synchronous even when process completion and
    output reads are asynchronous. A slow spawn can still delay Shell briefly.
17. A persistent plugin avoids recurring spawn cost but still competes for host
    resources. Niceness and protocol bounds reduce risk; they cannot prevent an
    intentionally abusive executable from affecting the system.
18. Only direct children are supervised. Plugins must stay in the foreground,
    flush complete JSON lines, and must not daemonize or fork background workers.
19. Per version 1 of the presentation-time protocol, a compositor MUST report
    `refresh = 0` whenever an output's refresh rate is not guaranteed constant,
    which includes VRR/Adaptive-Sync-capable outputs whether or not VRR is
    actively engaged. On such real displays, the acceptance tooling's
    long-presentation-interval clustering (Section 17.5) observes `refresh = 0`
    on every frame and reports zero long intervals unconditionally; this is
    the protocol working as specified, not evidence of jank-free delivery. The
    nested virtual-monitor test fixture is not VRR-capable and is unaffected.
    Delivered-frame-rate comparison and its confidence interval do not depend
    on the refresh field and remain authoritative on real hardware.

## 19. Delivery Order

### Phase 0: Performance Harness

- Minimal persistent fixed-width label
- Constant and changing synthetic plugins
- Mutation counters
- Monotonic phase timings
- Stage trace hooks
- Synthetic external spawn timing
- `off`, `summary`, and mutation-armed `trace` overhead comparison
- Baseline/constant/change A/B capture on the affected laptop

No feature work proceeds if a single persistent same-width label change still
reproduces the full frame-drop pattern. That result would move the primary
investigation back to Mutter/amdgpu repaint behavior.

### Phase 1: Universal Runtime and Protocol

- Manifest discovery
- Bounded one-shot runner and scheduler
- Supervised streaming runner with rate limits and restart backoff
- JSON validation
- Persistent plugin indicators and lazy menus
- Synthetic protocol and lifecycle fixtures

### Phase 2: Reference Plugins

- Consolidated CPU, GPU, memory, disk, and network stream plugin
- Default 250-ms CPU/GPU/network sampling and freshness acceptance measurements
- Combined fixed-width system indicator output
- Dependabot, pull-request, VPN, and weather one-shot plugins
- Reference plugin parser and protocol tests
- One-hour stability and frame-latency run

### Phase 3: Diagnostics and Preferences

- Summary histograms
- Time-limited detailed trace
- Sanitized export
- Plugin health/preferences UI
- Repeat complete acceptance matrix

## 20. Definition of Done

Version 1 is complete only when:

- all eight current status functions are available
- current high-frequency local scripts are no longer executed
- changed CPU and network values meet the 250-ms default cadence and freshness
  targets in Sections 3 and 7.1
- ordinary refreshes create and destroy no actors
- unchanged output produces no UI mutation
- every plugin runtime phase is measured and exportable
- limits and failure behavior are covered by tests
- enable/disable leaves no processes, sources, handlers, or actors behind
- the full workload passes the frame-latency acceptance criteria on the affected
  laptop
- limitations in Section 18 are documented for users

Performance claims MUST cite captured measurements and the exact build,
hardware, monitor layout, refresh rates, and test duration. Average CPU usage
alone is not acceptable evidence of compositor safety.

## 21. Technical References

- [GNOME Shell extension architecture](https://gjs.guide/extensions/overview/architecture.html)
- [GJS asynchronous programming](https://gjs.guide/guides/gjs/asynchronous-programming.html)
- [GJS `Gio.Subprocess` guidance](https://gjs.guide/guides/gio/subprocesses.html)
- [GJS memory-management guidance](https://gjs.guide/guides/gjs/memory-management.html)
- [GNOME Shell extension review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- [Linux `/proc/stat` documentation](https://docs.kernel.org/filesystems/proc.html#miscellaneous-kernel-statistics-in-proc-stat)
- [Linux block I/O statistics](https://docs.kernel.org/admin-guide/iostats.html)
- [Linux network-interface statistics](https://docs.kernel.org/networking/statistics.html)
