# GJS GNOME Shell Extension Conventions

These conventions apply to GNOME Shell extensions written in GJS in addition
to `AGENTS.universal.md`.

---

## Platform

- Use ES modules for extensions targeting GNOME Shell 45 and newer.
- List only GNOME Shell versions that have been tested in `metadata.json`.
- Prefer stable GLib, Gio, GObject, and other GNOME Platform APIs over Shell
  internals.
- Keep version-specific compatibility code isolated and covered by a smoke test.
- Do not import Gtk, Gdk, or Adw in the GNOME Shell process. They belong in
  `prefs.js`, which runs in a separate process.
- Do not import Clutter, Meta, Shell, St, or GNOME Shell UI modules in the
  preferences process.
- Distributed JavaScript must remain readable. Do not minify extension code.

---

## Lifecycle

- Module import and the extension constructor are side-effect free. Create no
  actors, settings handlers, file monitors, subprocesses, or main-loop sources
  before `enable()`.
- `enable()` owns every resource created by the extension. Store every actor,
  signal-handler ID, source ID, monitor, cancellable, and subprocess needed for
  cleanup.
- `disable()` stops new work first, then removes sources, disconnects signals,
  cancels asynchronous work, terminates direct children, destroys actors, and
  clears references.
- Asynchronous completions check a lifecycle generation or cancellation token
  before changing state. A callback from an earlier enable generation never
  touches current actors.
- Repeated enable/disable cycles must not retain actors, signal handlers, main
  loop sources, processes, or JavaScript closures.
- Do not call `run_dispose()` to compensate for unclear ownership. Fix the
  ownership model instead.

---

## Main Loop and I/O

Extension JavaScript executes in GNOME Shell's main context. Treat every
synchronous callback as compositor-critical work.

- Do not use synchronous file, network, DNS, or subprocess-waiting APIs during
  normal operation.
- Use Gio asynchronous APIs and `Gio.Cancellable`. Remember that completion
  callbacks return to the Shell main context and must remain bounded.
- Do not perform unbounded parsing, iteration, serialization, or logging in a
  callback.
- Use monotonic time for scheduling and duration measurements.
- Skip missed periodic deadlines. Never replay missed work in a catch-up burst.
- Prevent overlapping executions of the same operation.
- Coalesce related state changes into one low-priority or idle UI batch.
- Document a synchronous callback budget for performance-sensitive extensions
  and record violations in diagnostics.
- Do not assume that `async` makes the work inside a completion callback run on
  another thread.

---

## Actors and Rendering

- Create stable panel and menu actors once and update their properties in place.
- Compare old and new semantic state before writing an actor property.
- Identical state performs no actor mutation and must not request a repaint.
- Do not remove and rebuild an actor subtree for periodic data updates.
- Create expensive or optional menu content lazily and retain it after creation.
- Key repeated menu items by stable IDs and update, move, add, or remove only the
  changed items.
- Keep frequently changing panel content in a stable allocation. Use fixed-width
  fields where numeric changes would otherwise reflow the panel.
- Avoid animations for periodic status changes unless the animation is itself a
  product requirement and has a frame-latency test.
- Plain text is the default. Markup, arbitrary CSS, and decoded image data require
  explicit validation, caching, and a documented need.
- Actor creation and destruction during ordinary refreshes is a performance
  regression unless the semantic structure actually changed.

---

## Subprocesses

- Avoid repeated high-frequency process creation. Use in-process asynchronous
  operations when they fit the product boundary, or one bounded persistent
  child when executable plugins are the product abstraction.
- Use `Gio.SubprocessLauncher` with an argv array. Never construct an implicit
  shell command line from data.
- Treat subprocess creation as synchronous main-context work and measure it in
  performance-sensitive paths.
- Capture stdout and stderr separately, read both asynchronously, and enforce
  byte limits before decoding or parsing.
- Set a deadline, cancel outstanding reads, terminate the direct child, and reap
  it on every completion path.
- Do not use a convenience API that buffers unbounded child output.
- Do not let one task overlap itself, and set a global concurrency limit when
  several tasks can launch children.
- For persistent children, define framing, maximum line and buffer sizes,
  message and byte rates, startup and heartbeat deadlines, restart backoff, and
  crash-loop lockout. Retain no unbounded output history.
- Document that terminating a direct child does not necessarily terminate a
  daemonized grandchild. User plugins must not daemonize.

---

## State, Errors, and Security

- Data sources produce plain semantic state and never mutate actors directly.
- Rendering consumes explicit state changes instead of reading source globals.
- Validate configuration and external data before replacing the last valid
  state.
- Fail fast when extension setup is invalid. Isolate runtime source failures so
  one failure cannot disable unrelated sources.
- Repeated identical failures update bounded counters without repeatedly
  repainting the same error state.
- Never use `eval()` for plugin behavior or data rendering.
- Render untrusted output as plain text. Do not interpret markup by default.
- Pass subprocess arguments as argv and inherit environment variables through an
  explicit allowlist.
- Never include secrets, authorization values, raw plugin output, or URI query
  strings in ordinary logs or diagnostic exports.

---

## Diagnostics

The universal `--debug` and `--trace` CLI flags do not apply to an in-process
GNOME Shell extension because it has no command-line entry point.

- Default journal output is warnings and errors only. Do not log every refresh.
- Keep bounded in-memory summary counters and duration histograms when ongoing
  performance diagnosis is a product requirement.
- Expose detailed tracing through preferences, GSettings, or a bounded session
  D-Bus interface.
- Detailed traces are opt-in, time-limited, size-limited, and automatically
  disabled after capture.
- Write trace exports asynchronously below `$XDG_CACHE_HOME/<project>/`.
- Correlate phases with monotonic timestamps and a cycle ID.
- Distinguish extension callback, actor update, Shell paint, GPU, KMS, and
  presentation timing. Do not claim to measure a lower layer from a higher-layer
  signal.
- Measure diagnostic overhead separately. A tracing mechanism that changes the
  observed behavior is not suitable for primary acceptance results.

---

## Settings and Files

- Use GSettings for extension preferences and validate values read from it.
- Use `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME`, and `$XDG_DATA_HOME` for user files.
- File monitors are noisy. Debounce before changing state and update only the
  affected object.
- Compile schemas as a build artifact. Do not commit `gschemas.compiled`.
- Keep the extension UUID, source directory, schema ID, D-Bus names, and XDG
  paths consistent.

---

## Code Style

- Follow the GNOME Shell ESLint configuration and the surrounding GNOME code
  style where the project has no established alternative.
- Use `const` by default and `let` only for reassignment. Do not use `var`.
- Use ES classes and relative ES-module imports for project code.
- Keep `extension.js` limited to lifecycle wiring and top-level composition.
- Keep parsing, scheduling, comparison, formatting, and diagnostics logic free
  of Shell UI imports where practical so it can run in ordinary GJS tests.
- Document exported functions, classes, and constants with concise JSDoc.
- Do not add an npm or other runtime dependency when the GNOME Platform already
  provides the required operation.

---

## Testing and Validation

- Pure modules have deterministic GJS unit tests next to the source they test.
- Scheduler tests use an injected clock rather than sleeping.
- Every bug involving lifecycle, parsing, state comparison, or rendering gets a
  regression test.
- Actor tests count property writes, creations, and destructions rather than
  relying only on screenshots.
- Integration tests run in a nested Wayland GNOME Shell for supported versions.
- Performance-sensitive extensions define an A/B test against the extension-
  disabled baseline on representative display hardware.
- `make check` is the single validation gate. For an extension it runs format
  checks, metadata/schema validation, packaging, unit tests, and linting in a
  documented order.
- Missing tools print an install command and exit. Validation never installs
  dependencies automatically.

---

## Never

- Never perform synchronous network or process-waiting work in GNOME Shell.
- Never rebuild unchanged actor trees on a timer.
- Never leave a source, signal, monitor, child, or actor alive after `disable()`.
- Never process unbounded plugin or network output in the Shell process.
- Never emit continuous journal logs for normal updates.
- Never describe average CPU usage alone as evidence of frame-latency safety.
