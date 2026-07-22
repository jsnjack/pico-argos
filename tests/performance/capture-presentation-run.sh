#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

if (($# != 2)); then
    echo "Usage: $0 OUTPUT_DIRECTORY DURATION_SECONDS" >&2
    exit 2
fi
output_dir=$1
duration_seconds=$2
if [[ ! $duration_seconds =~ ^[0-9]+$ ]] ||
    ((duration_seconds < 10 || duration_seconds > 86400)); then
    echo 'Duration must be from 10 through 86400 seconds' >&2
    exit 2
fi
if [[ -e $output_dir ]]; then
    echo "Output path already exists: $output_dir" >&2
    exit 1
fi
mkdir -m 700 -- "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
presentation_client=${PICO_ARGOS_PRESENTATION_CLIENT:-}
if [[ -z $presentation_client || ! -x $presentation_client ]]; then
    echo 'PICO_ARGOS_PRESENTATION_CLIENT must name the built timing client' >&2
    exit 1
fi
for command_name in gdbus gjs gnome-shell journalctl jq pidstat; do
    command -v "$command_name" >/dev/null || {
        echo "Missing capture command: $command_name" >&2
        exit 1
    }
done

shell_reply=$(gdbus call --session \
    --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetConnectionUnixProcessID \
    org.gnome.Shell)
shell_pid=$(sed -E 's/.*uint32 ([0-9]+).*/\1/' <<<"$shell_reply")
if [[ ! $shell_pid =~ ^[0-9]+$ ]] || [[ ! -r /proc/$shell_pid/status ]]; then
    echo 'Could not resolve the live GNOME Shell process' >&2
    exit 1
fi

capture_summary() {
    local destination=$1
    if gjs -m "$repo_root/tests/integration/dbus-client.js" summary \
        >"$destination.pending" 2>/dev/null; then
        mv "$destination.pending" "$destination"
    else
        rm -f -- "$destination.pending"
        jq -n '{available:false, reason:"extension diagnostics unavailable"}' \
            >"$destination"
    fi
}

capture_summary "$output_dir/summary-before.json"
gdbus call --session \
    --dest org.gnome.Mutter.DisplayConfig \
    --object-path /org/gnome/Mutter/DisplayConfig \
    --method org.gnome.Mutter.DisplayConfig.GetCurrentState \
    >"$output_dir/display-config.txt"

start_epoch=$(date +%s)
start_monotonic=$(cut -d' ' -f1 /proc/uptime)
power_profile=unavailable
if command -v powerprofilesctl >/dev/null; then
    power_profile=$(powerprofilesctl get 2>/dev/null || echo unavailable)
fi
package_hash=unavailable
package_path="$repo_root/dist/pico-argos@jsnjack.github.io.shell-extension.zip"
if [[ -f $package_path ]]; then
    package_hash=$(sha256sum "$package_path" | cut -d' ' -f1)
fi
jq -n \
    --arg scenario "${PICO_ARGOS_SCENARIO:-manual}" \
    --arg diagnosticsMode "${PICO_ARGOS_DIAGNOSTICS_MODE:-unknown}" \
    --arg redrawMode "${PICO_ARGOS_REDRAW_MODE:-unknown}" \
    --arg runRole "${PICO_ARGOS_RUN_ROLE:-unpaired}" \
    --arg pair "${PICO_ARGOS_PAIR:-0}" \
    --arg commit "$(git -C "$repo_root" rev-parse HEAD)" \
    --arg packageSha256 "$package_hash" \
    --arg shellVersion "$(gnome-shell --version)" \
    --arg gjsVersion "$(gjs --version)" \
    --arg powerProfile "$power_profile" \
    --arg startEpoch "$start_epoch" \
    --arg startMonotonicSeconds "$start_monotonic" \
    --argjson shellPid "$shell_pid" \
    --argjson durationSeconds "$duration_seconds" \
    '{formatVersion:1, project:"pico-argos", scenario:$scenario,
      diagnosticsMode:$diagnosticsMode, redrawMode:$redrawMode,
      runRole:$runRole, pair:$pair,
      commit:$commit, packageSha256:$packageSha256,
      shellVersion:$shellVersion, gjsVersion:$gjsVersion,
      powerProfile:$powerProfile, startEpoch:$startEpoch,
      startMonotonicSeconds:$startMonotonicSeconds,
      shellPid:$shellPid, durationSeconds:$durationSeconds}' \
    >"$output_dir/environment.json"

pidstat -h -u -r -w -p "$shell_pid" 1 "$duration_seconds" \
    >"$output_dir/pidstat.txt" 2>&1 &
pidstat_pid=$!
(
    printf 'monotonic_seconds\tpid\tppid\trss_kib\tthreads\tcommand\n'
    end=$((SECONDS + duration_seconds))
    while ((SECONDS <= end)); do
        now=$(cut -d' ' -f1 /proc/uptime)
        ps -o pid=,ppid=,rss=,nlwp=,comm= -p "$shell_pid" --ppid "$shell_pid" |
            awk -v timestamp="$now" '{print timestamp "\t" $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5}'
        sleep 10
    done
) >"$output_dir/process-memory.tsv" &
memory_pid=$!

perf_pid=
if command -v perf >/dev/null; then
    perf stat -o "$output_dir/perf-stat.txt" -p "$shell_pid" \
        -e task-clock,context-switches,cpu-migrations,page-faults \
        -- sleep "$duration_seconds" >/dev/null 2>&1 &
    perf_pid=$!
fi

WAYLAND_DISPLAY=${WAYLAND_DISPLAY:?WAYLAND_DISPLAY is not set} \
    "$presentation_client" "$duration_seconds" \
    >"$output_dir/presentation.ndjson"
wait "$pidstat_pid" || true
kill "$memory_pid" >/dev/null 2>&1 || true
wait "$memory_pid" 2>/dev/null || true
if [[ -n $perf_pid ]]; then
    wait "$perf_pid" || true
fi

capture_summary "$output_dir/summary-after.json"
journalctl --user --since "@$start_epoch" -o short-monotonic \
    _COMM=gnome-shell >"$output_dir/gnome-shell.journal.txt" 2>&1 || true
"$repo_root/tests/performance/analyze-presentation.js" \
    "$output_dir/presentation.ndjson" \
    >"$output_dir/presentation-summary.json"
