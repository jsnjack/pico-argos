#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

if (($# != 1)); then
    echo "Usage: $0 NEW_OUTPUT_DIRECTORY" >&2
    echo 'Optional environment: PICO_ARGOS_RUN_SECONDS, PICO_ARGOS_PAIRS, PICO_ARGOS_ONE_HOUR_SECONDS' >&2
    exit 2
fi
output_root=$1
run_seconds=${PICO_ARGOS_RUN_SECONDS:-60}
pairs=${PICO_ARGOS_PAIRS:-5}
one_hour_seconds=${PICO_ARGOS_ONE_HOUR_SECONDS:-3600}
if [[ ! $run_seconds =~ ^[0-9]+$ ]] || ((run_seconds < 30 || run_seconds > 3600)); then
    echo 'PICO_ARGOS_RUN_SECONDS must be from 30 through 3600' >&2
    exit 2
fi
if [[ ! $pairs =~ ^[0-9]+$ ]] || ((pairs < 5 || pairs > 20)); then
    echo 'PICO_ARGOS_PAIRS must be from 5 through 20' >&2
    exit 2
fi
if [[ ! $one_hour_seconds =~ ^[0-9]+$ ]] ||
    ! ((one_hour_seconds == 0 ||
        (one_hour_seconds >= 3600 && one_hour_seconds <= 86400))); then
    echo 'PICO_ARGOS_ONE_HOUR_SECONDS must be 0 or from 3600 through 86400' >&2
    exit 2
fi
if [[ -e $output_root ]]; then
    echo "Output path already exists: $output_root" >&2
    exit 1
fi
mkdir -m 700 -- "$output_root"
output_root=$(cd "$output_root" && pwd)
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
uuid=pico-argos@jsnjack.github.io
schema=org.gnome.shell.extensions.pico-argos
plugin_root="${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/pico-argos/plugins"
for command_name in gdbus gjs gnome-extensions gsettings jq make; do
    command -v "$command_name" >/dev/null || {
        echo "Missing acceptance command: $command_name" >&2
        exit 1
    }
done
if [[ ${XDG_SESSION_TYPE:-} != wayland ]]; then
    echo 'Frame-latency acceptance must run in the affected Wayland login session' >&2
    exit 1
fi
if ! gnome-extensions info "$uuid" >/dev/null 2>&1; then
    echo 'Install the current package, log out/in, then rerun acceptance' >&2
    exit 1
fi

# gnome-extensions install places the schema only inside the extension's own
# directory; it is never compiled into a system/user glib-2.0/schemas path,
# so the standalone gsettings CLI cannot see it without an explicit schema
# directory, unlike GNOME Shell itself, which loads extension schemas from
# their own directory internally.
extension_schema_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid/schemas"
if [[ ! -f "$extension_schema_dir/gschemas.compiled" ]]; then
    echo "Compiled schema missing at $extension_schema_dir; reinstall with 'make install'" >&2
    exit 1
fi
export GSETTINGS_SCHEMA_DIR=$extension_schema_dir

original_disabled=$(gsettings get "$schema" disabled-plugins)
original_diagnostics=$(gsettings get "$schema" diagnostics-mode)
original_enabled=false
if gnome-extensions list --enabled | grep -qx "$uuid"; then
    original_enabled=true
fi
staged_paths=()
cleaned_up=false
cleanup() {
    [[ $cleaned_up == true ]] && return
    cleaned_up=true
    set +e
    gnome-extensions disable "$uuid" >/dev/null 2>&1
    for path in "${staged_paths[@]}"; do
        if [[ $path == "$plugin_root"/perf-* && -d $path ]]; then
            rm -rf -- "$path"
        fi
    done
    gsettings set "$schema" disabled-plugins "$original_disabled" >/dev/null
    gsettings set "$schema" diagnostics-mode "$original_diagnostics" >/dev/null
    if [[ $original_enabled == true ]]; then
        gnome-extensions enable "$uuid" >/dev/null 2>&1
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
install -d -m 700 -- "$plugin_root"

stage_plugin() {
    local source=$1
    local id=$2
    local target="$plugin_root/$id"
    if [[ ! $id =~ ^perf-[a-z0-9-]+$ ]] || [[ -e $target ]]; then
        echo "Refusing to replace acceptance plugin path: $target" >&2
        exit 1
    fi
    install -d -m 700 -- "$target"
    cp -R -- "$source/." "$target/"
    jq --arg id "$id" '.id = $id' "$target/plugin.json" \
        >"$target/plugin.json.new"
    chmod 600 "$target/plugin.json.new"
    mv "$target/plugin.json.new" "$target/plugin.json"
    chmod -R u+rwX,go-rwx -- "$target"
    staged_paths+=("$target")
}

stage_plugin "$script_dir/plugins/perf-constant" perf-constant
stage_plugin "$script_dir/plugins/perf-changing" perf-changing
stage_plugin "$script_dir/plugins/perf-oneshot" perf-oneshot
for name in system-monitor dependabot pull-reviews vpn weather; do
    stage_plugin "$repo_root/plugins/$name" "perf-full-$name"
done

all_plugins=()
shopt -s nullglob
for path in "$plugin_root"/*; do
    [[ -d $path ]] || continue
    id=${path##*/}
    if [[ $id =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
        all_plugins+=("$id")
    fi
done
if ((${#all_plugins[@]} > 16)); then
    echo "Acceptance needs at most 16 plugin directories; found ${#all_plugins[@]}" >&2
    exit 1
fi

presentation_client="$output_root/presentation-client"
"$script_dir/build-presentation-client.sh" "$presentation_client"
export PICO_ARGOS_PRESENTATION_CLIENT=$presentation_client
"$script_dir/monitor-state.js" --require-dual-120 \
    >"$output_root/monitor-state.json"

variant_for_disabled() {
    local enabled_list=" $1 "
    local value='['
    local id
    for id in "${all_plugins[@]}"; do
        if [[ $enabled_list == *" $id "* ]]; then
            continue
        fi
        value+="'$id',"
    done
    value=${value%,}
    value+=']'
    printf '%s' "$value"
}

wait_for_runtime_count() {
    local count=$1
    local pending="$output_root/runtime.pending.json"
    for _attempt in $(seq 1 100); do
        if gjs -m "$repo_root/tests/integration/dbus-client.js" summary \
            >"$pending" 2>/dev/null &&
            jq -e --argjson count "$count" \
                '.runtime.plugins | length == $count' "$pending" >/dev/null; then
            rm -f -- "$pending"
            return 0
        fi
        sleep 0.1
    done
    echo "Runtime did not settle at $count plugins" >&2
    return 1
}

scenario_plugins() {
    case $1 in
        empty) printf '%s' '' ;;
        constant) printf '%s' 'perf-constant' ;;
        changing) printf '%s' 'perf-changing' ;;
        oneshot) printf '%s' 'perf-oneshot' ;;
        full)
            printf '%s' 'perf-full-system-monitor perf-full-dependabot perf-full-pull-reviews perf-full-vpn perf-full-weather'
            ;;
        *) echo "Unknown scenario: $1" >&2; return 1 ;;
    esac
}

apply_scenario() {
    local role=$1
    local scenario=$2
    local enabled
    if [[ $role == baseline ]]; then
        gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
        sleep 2
        return
    fi
    enabled=$(scenario_plugins "$scenario")
    gsettings set "$schema" disabled-plugins "$(variant_for_disabled "$enabled")"
    gnome-extensions enable "$uuid" >/dev/null
    local expected=0
    if [[ -n $enabled ]]; then
        read -r -a expected_plugins <<<"$enabled"
        expected=${#expected_plugins[@]}
    fi
    wait_for_runtime_count "$expected"
    sleep 5
}

capture() {
    local mode=$1
    local scenario=$2
    local pair=$3
    local role=$4
    local duration=$5
    apply_scenario "$role" "$scenario"
    export PICO_ARGOS_DIAGNOSTICS_MODE=$mode
    export PICO_ARGOS_SCENARIO=$scenario
    export PICO_ARGOS_PAIR=$pair
    export PICO_ARGOS_RUN_ROLE=$role
    "$script_dir/capture-presentation-run.sh" \
        "$output_root/$mode-$scenario-pair-$pair-$role" "$duration"
}

failures=0
for mode in summary off; do
    gsettings set "$schema" diagnostics-mode "'$mode'"
    for scenario in empty constant changing oneshot full; do
        comparison_args=()
        for pair in $(seq 1 "$pairs"); do
            baseline_dir="$output_root/$mode-$scenario-pair-$pair-baseline"
            scenario_dir="$output_root/$mode-$scenario-pair-$pair-scenario"
            if ((pair % 2 == 1)); then
                capture "$mode" "$scenario" "$pair" baseline "$run_seconds"
                capture "$mode" "$scenario" "$pair" scenario "$run_seconds"
            else
                capture "$mode" "$scenario" "$pair" scenario "$run_seconds"
                capture "$mode" "$scenario" "$pair" baseline "$run_seconds"
            fi
            comparison_args+=(
                "$baseline_dir/presentation-summary.json"
                "$scenario_dir/presentation-summary.json")
        done
        if ! "$script_dir/compare-presentation.js" "${comparison_args[@]}" \
            >"$output_root/$mode-$scenario-comparison.json"; then
            failures=$((failures + 1))
        fi
    done
done

if ((one_hour_seconds != 0)); then
    gsettings set "$schema" diagnostics-mode "'summary'"
    capture summary full steady-state scenario "$one_hour_seconds"
    if ! "$script_dir/analyze-steady-state.js" \
        "$output_root/summary-full-pair-steady-state-scenario/summary-before.json" \
        "$output_root/summary-full-pair-steady-state-scenario/summary-after.json" \
        "$output_root/summary-full-pair-steady-state-scenario/process-memory.tsv" \
        >"$output_root/steady-state-analysis.json"; then
        failures=$((failures + 1))
    fi
fi

jq -n \
    --argjson pairedRuns "$pairs" \
    --argjson runSeconds "$run_seconds" \
    --argjson oneHourSeconds "$one_hour_seconds" \
    --argjson failedComparisons "$failures" \
    '{formatVersion:1, project:"pico-argos", pairedRuns:$pairedRuns,
      runSeconds:$runSeconds, oneHourSeconds:$oneHourSeconds,
      failedComparisons:$failedComparisons,
      passed:($failedComparisons == 0)}' >"$output_root/result.json"
if ((failures != 0)); then
    exit 1
fi
