#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

if (($# != 1)); then
    echo "Usage: $0 NEW_OUTPUT_DIRECTORY" >&2
    echo 'Optional environment: PICO_ARGOS_RUN_SECONDS, PICO_ARGOS_PAIRS' >&2
    exit 2
fi
output_root=$1
run_seconds=${PICO_ARGOS_RUN_SECONDS:-20}
pairs=${PICO_ARGOS_PAIRS:-5}
if [[ ! $run_seconds =~ ^[0-9]+$ ]] ||
    ((run_seconds < 20 || run_seconds > 3600)); then
    echo 'PICO_ARGOS_RUN_SECONDS must be from 20 through 3600' >&2
    exit 2
fi
if [[ ! $pairs =~ ^[0-9]+$ ]] || ((pairs < 5 || pairs > 20)); then
    echo 'PICO_ARGOS_PAIRS must be from 5 through 20' >&2
    exit 2
fi
if [[ -e $output_root ]]; then
    echo "Output path already exists: $output_root" >&2
    exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
uuid=pico-argos@jsnjack.github.io
schema=org.gnome.shell.extensions.pico-argos
schema_dir="${XDG_DATA_HOME:-${HOME:?HOME is not set}/.local/share}/gnome-shell/extensions/$uuid/schemas"
for command_name in gjs gnome-extensions gsettings jq rg; do
    command -v "$command_name" >/dev/null || {
        echo "Missing redraw A/B command: $command_name" >&2
        exit 1
    }
done
if [[ ${XDG_SESSION_TYPE:-} != wayland ]]; then
    echo 'The redraw A/B must run in the affected Wayland login session' >&2
    exit 1
fi
if ! gnome-extensions list --enabled | rg -qx "$uuid"; then
    echo 'Enable pico-argos before running the redraw A/B' >&2
    exit 1
fi
if [[ ! -f $schema_dir/gschemas.compiled ]]; then
    echo "Compiled installed schema missing at $schema_dir" >&2
    exit 1
fi

settings() {
    gsettings --schemadir "$schema_dir" "$@"
}
if ! settings list-keys "$schema" | rg -qx performance-explicit-redraw; then
    echo 'The installed package does not contain the redraw A/B setting' >&2
    exit 1
fi
original_redraw=$(settings get "$schema" performance-explicit-redraw)
cleanup() {
    set +e
    settings set "$schema" performance-explicit-redraw "$original_redraw" \
        >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -m 700 -- "$output_root"
output_root=$(cd "$output_root" && pwd)
original_summary="$output_root/original-summary.json"
if ! gjs -m "$repo_root/tests/integration/dbus-client.js" summary \
    >"$original_summary" ||
    ! jq -e '.runtime.explicitPanelRedraw | type == "boolean"' \
        "$original_summary" >/dev/null; then
    echo 'The live Shell has not loaded the redraw diagnostic selector; log out and in once' >&2
    exit 1
fi
mapfile -t plugins < <(jq -r '.runtime.plugins[].id' "$original_summary")
if ((${#plugins[@]} == 0)); then
    echo 'The live extension has no enabled plugins to measure' >&2
    exit 1
fi

presentation_client="$output_root/presentation-client"
"$script_dir/build-presentation-client.sh" "$presentation_client"
export PICO_ARGOS_PRESENTATION_CLIENT=$presentation_client
"$script_dir/monitor-state.js" >"$output_root/monitor-state.json"

apply_redraw_mode() {
    local enabled=$1
    local pending="$output_root/redraw-mode.pending.json"
    settings set "$schema" performance-explicit-redraw "$enabled"
    for _attempt in $(seq 1 50); do
        if gjs -m "$repo_root/tests/integration/dbus-client.js" summary \
            >"$pending" 2>/dev/null &&
            jq -e --argjson enabled "$enabled" \
                '.runtime.explicitPanelRedraw == $enabled' \
                "$pending" >/dev/null; then
            rm -f -- "$pending"
            sleep 1
            return
        fi
        sleep 0.1
    done
    echo "Live redraw mode did not change to $enabled" >&2
    return 1
}

capture() {
    local pair=$1
    local role=$2
    local enabled=false
    if [[ $role == scenario ]]; then
        enabled=true
    fi
    echo "Starting redraw A/B pair $pair/$pairs: $role (explicit redraw: $enabled)"
    apply_redraw_mode "$enabled"
    PICO_ARGOS_DIAGNOSTICS_MODE=summary \
    PICO_ARGOS_SCENARIO=redraw \
    PICO_ARGOS_REDRAW_MODE="$([[ $enabled == true ]] && echo explicit || echo label-only)" \
    PICO_ARGOS_PAIR=$pair \
    PICO_ARGOS_RUN_ROLE=$role \
        "$script_dir/capture-presentation-run.sh" \
        "$output_root/summary-redraw-pair-$pair-$role" "$run_seconds"
}

comparison_args=()
baseline_summaries=()
scenario_summaries=()
for pair in $(seq 1 "$pairs"); do
    if ((pair % 2 == 1)); then
        capture "$pair" baseline
        capture "$pair" scenario
    else
        capture "$pair" scenario
        capture "$pair" baseline
    fi
    baseline_summary="$output_root/summary-redraw-pair-$pair-baseline/presentation-summary.json"
    scenario_summary="$output_root/summary-redraw-pair-$pair-scenario/presentation-summary.json"
    baseline_summaries+=("$baseline_summary")
    scenario_summaries+=("$scenario_summary")
    comparison_args+=("$baseline_summary" "$scenario_summary")
done

"$script_dir/compare-presentation.js" --practical-margin-percent 1 \
    "${comparison_args[@]}" \
    >"$output_root/summary-redraw-comparison.json" || true
jq -e '.practicalEffect != null' \
    "$output_root/summary-redraw-comparison.json" >/dev/null
baseline_freezes=$(jq -s \
    '[.[].framePacing.freezeLikePauses.count] | add' \
    "${baseline_summaries[@]}")
scenario_freezes=$(jq -s \
    '[.[].framePacing.freezeLikePauses.count] | add' \
    "${scenario_summaries[@]}")
plugins_json=$(printf '%s\n' "${plugins[@]}" | jq -R . | jq -s .)
jq -n \
    --argjson pairedRuns "$pairs" \
    --argjson runSeconds "$run_seconds" \
    --argjson plugins "$plugins_json" \
    --argjson baselineFreezes "$baseline_freezes" \
    --argjson scenarioFreezes "$scenario_freezes" \
    --slurpfile comparison "$output_root/summary-redraw-comparison.json" \
    '($comparison[0].practicalEffect.decision) as $frameDecision |
      (if $scenarioFreezes > $baselineFreezes then "freeze-regression"
       else $frameDecision end) as $decision |
      {formatVersion:1, project:"pico-argos", measurement:"redraw-ab",
      baseline:"label-only", scenario:"explicit-panel-button-redraw",
      plugins:$plugins, pairedRuns:$pairedRuns, runSeconds:$runSeconds,
      oneHourSeconds:0,
      practicalMarginPercent:$comparison[0].practicalEffect.marginPercent,
      frameRateDecision:$frameDecision,
      decision:$decision,
      conclusive:($decision != "inconclusive"),
      confidence95Percent:$comparison[0].confidence95Percent,
      freezeLikePauses:{baseline:$baselineFreezes, scenario:$scenarioFreezes},
      passed:($decision == "no-material-effect" or
              $decision == "material-improvement")}' \
    >"$output_root/result.json"

expected_exit=$(jq -r 'if .passed then 0 else 1 end' "$output_root/result.json")
report_exit=0
"$script_dir/run-performance-report.sh" --report-only "$output_root" ||
    report_exit=$?
if ((report_exit != expected_exit)); then
    echo 'Rendered report verdict disagrees with the redraw comparison' >&2
    exit 1
fi
exit "$expected_exit"
