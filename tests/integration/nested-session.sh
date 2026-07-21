#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

uuid=pico-argos@jsnjack.github.io
actor_uuid=pico-argos-actor-test@jsnjack.github.io
test_root=$PICO_ARGOS_TEST_ROOT
repo_root=$PICO_ARGOS_REPO_ROOT
plugin_dir="$test_root/config/pico-argos/plugins/smoke"
shell_log="$test_root/shell.log"
prefs_log="$test_root/preferences.log"
summary_file="$test_root/summary.json"
presentation_file="$test_root/presentation.ndjson"
export XDG_CONFIG_HOME="$test_root/config"
export XDG_CACHE_HOME="$test_root/cache"
export XDG_DATA_HOME="$test_root/data"
export XDG_RUNTIME_DIR="$test_root/runtime"
export XDG_DATA_DIRS="/usr/local/share:/usr/share"
export GSETTINGS_SCHEMA_DIR="$test_root/data/gnome-shell/extensions/$uuid/schemas"
export GSETTINGS_BACKEND=keyfile

wait_for_summary() {
    local filter=$1
    local pending="$summary_file.pending"
    for _attempt in $(seq 1 80); do
        if gjs -m "$repo_root/tests/integration/dbus-client.js" summary \
            >"$pending" 2>/dev/null && jq -e "$filter" "$pending" >/dev/null; then
            mv "$pending" "$summary_file"
            return 0
        fi
        sleep 0.1
    done
    echo "Timed out waiting for diagnostic summary: $filter" >&2
    cat "$shell_log" >&2
    return 1
}

shell_pid=
prefs_pid=
cleanup() {
    if [[ -n $prefs_pid ]]; then
        kill "$prefs_pid" 2>/dev/null || true
        wait "$prefs_pid" 2>/dev/null || true
    fi
    if [[ -n $shell_pid ]]; then
        kill "$shell_pid" 2>/dev/null || true
        wait "$shell_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT

gnome-shell --devkit --wayland --no-x11 \
    --wayland-display=pico-argos-integration \
    --virtual-monitor=1280x720@60 >"$shell_log" 2>&1 &
shell_pid=$!

for _attempt in $(seq 1 80); do
    if gdbus call --session \
        --dest org.gnome.Shell \
        --object-path /org/gnome/Shell \
        --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
        break
    fi
    sleep 0.1
done
if ! kill -0 "$shell_pid" 2>/dev/null; then
    echo 'Nested GNOME Shell exited during startup' >&2
    cat "$shell_log" >&2
    exit 1
fi

WAYLAND_DISPLAY=pico-argos-integration \
    "$PICO_ARGOS_PRESENTATION_CLIENT" 2 >"$presentation_file"
if ! jq -s -e '
    (map(select(.type == "environment")) | length) == 1 and
    (map(select(.type == "presented")) | length) >= 60 and
    (map(select(.type == "presented" and
        .refreshNanoseconds >= 16000000 and .refreshNanoseconds <= 17000000)) |
        length) >= 60
' "$presentation_file" >/dev/null; then
    echo 'Continuous Wayland presentation feedback capture failed' >&2
    tail -20 "$presentation_file" >&2
    exit 1
fi

gnome-extensions enable "$uuid"
wait_for_summary '.runtime.plugins | length == 1 and .[0].processState == "running"'
jq -e '
    .diagnostics.mutations["actor-creations"] == 4 and
    .diagnostics.mutations["actor-destructions"] == 0 and
    .diagnostics.mutations["menu-property-writes"] == 0 and
    .runtime.children.current == 1 and
    .runtime.children.peak == 1 and
    .runtime.plugins[0].lastCycleId == 1 and
    .diagnostics.phases["raw-compare"].count > 0 and
    .diagnostics.phases.parse.count > 0 and
    .diagnostics.phases.validate.count > 0 and
    .diagnostics.phases["semantic-diff"].count > 0
' "$summary_file" >/dev/null

gsettings set org.gnome.shell.extensions.pico-argos disabled-plugins "['smoke']"
wait_for_summary '.runtime.plugins | length == 0'
if pgrep -f "$plugin_dir/run" >/dev/null; then
    echo 'Disabled plugin child survived its preferences toggle' >&2
    exit 1
fi
gsettings set org.gnome.shell.extensions.pico-argos disabled-plugins "[]"
wait_for_summary '.runtime.plugins | length == 1 and .[0].processState == "running"'

gsettings set org.gnome.shell.extensions.pico-argos diagnostics-mode off
wait_for_summary '.diagnostics.mode == "off"'
gsettings set org.gnome.shell.extensions.pico-argos diagnostics-mode summary
wait_for_summary '.diagnostics.mode == "summary"'

cp "$plugin_dir/plugin.json" "$plugin_dir/plugin.json.invalid"
jq '.timeoutMs = 5000' "$plugin_dir/plugin.json" >"$plugin_dir/plugin.json.new"
chmod 600 "$plugin_dir/plugin.json.new"
mv "$plugin_dir/plugin.json.new" "$plugin_dir/plugin.json"
wait_for_summary '.registryErrors | length > 0'
jq -e '.runtime.plugins[0].processState == "running"' "$summary_file" >/dev/null

jq '.order = 11' "$plugin_dir/plugin.json.invalid" >"$plugin_dir/plugin.json.new"
chmod 600 "$plugin_dir/plugin.json.new"
mv "$plugin_dir/plugin.json.new" "$plugin_dir/plugin.json"
wait_for_summary '.runtime.plugins[0].runs >= 2 and .runtime.plugins[0].processState == "running"'

gjs -m "$repo_root/tests/integration/dbus-client.js" start-trace 2 >/dev/null
cp "$plugin_dir/run" "$plugin_dir/run.new"
chmod 700 "$plugin_dir/run.new"
mv "$plugin_dir/run.new" "$plugin_dir/run"
wait_for_summary '.runtime.plugins[0].runs >= 3 and .runtime.plugins[0].processState == "running"'
trace_path=
for _attempt in $(seq 1 60); do
    trace_path=$(find "$test_root/cache/pico-argos/diagnostics" \
        -maxdepth 1 -type f -name 'trace-*.json' -print -quit 2>/dev/null || true)
    if [[ -n $trace_path ]]; then
        break
    fi
    sleep 0.1
done
if [[ -z $trace_path ]]; then
    echo 'Diagnostic trace was not exported' >&2
    exit 1
fi
jq -e '
    .trace.eventCount == (.events | length) and
    .trace.dropped == 0 and
    (.events | map(.[0]) | index(8)) != null and
    (.events | map(.[0]) | index(9)) != null and
    (.events | map(.[0]) | index(11)) != null and
    (.events | map(.[0]) | index(27)) != null and
    .runtime.children.peak == 1 and
    .environment.monitors[0].refreshRate == 60 and
    .manifests[0].id == "smoke" and
    (.manifests[0] | has("command") | not)
' "$trace_path" >/dev/null

WAYLAND_DISPLAY=pico-argos-integration \
    gnome-extensions prefs "$uuid" >"$prefs_log" 2>&1 &
prefs_pid=$!
sleep 2
kill "$prefs_pid" 2>/dev/null || true
wait "$prefs_pid" 2>/dev/null || true
prefs_pid=
if rg -q 'Gjs-CRITICAL|JS ERROR' "$prefs_log"; then
    cat "$prefs_log" >&2
    exit 1
fi

gnome-extensions enable "$actor_uuid"
for _attempt in $(seq 1 50); do
    if rg -q '\[pico-argos-actor-test\] PASS' "$shell_log"; then
        break
    fi
    sleep 0.1
done
if ! rg -q '\[pico-argos-actor-test\] PASS' "$shell_log"; then
    echo 'Actor harness did not pass' >&2
    cat "$shell_log" >&2
    exit 1
fi
gnome-extensions disable "$actor_uuid"

gnome-extensions disable "$uuid"
sleep 1
if gjs -m "$repo_root/tests/integration/dbus-client.js" summary >/dev/null 2>&1; then
    echo 'Diagnostic interface survived extension disable' >&2
    exit 1
fi
if pgrep -f "$plugin_dir/run" >/dev/null; then
    echo 'Stream child survived extension disable' >&2
    exit 1
fi

gnome-extensions enable "$uuid"
wait_for_summary '.runtime.plugins[0].processState == "running"'
gnome-extensions disable "$uuid"
sleep 1
if pgrep -f "$plugin_dir/run" >/dev/null; then
    echo 'Stream child survived the second disable cycle' >&2
    exit 1
fi

if rg -q 'GNOME Shell-CRITICAL|Gjs-CRITICAL|Extension pico-argos.*ERROR|pico-argos-actor-test.*FAIL|free\(\): invalid' \
    "$shell_log"; then
    cat "$shell_log" >&2
    exit 1
fi

kill "$shell_pid"
wait "$shell_pid" || true
shell_pid=
if rg -q 'free\(\): invalid' "$shell_log"; then
    cat "$shell_log" >&2
    exit 1
fi
