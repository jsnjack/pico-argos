#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail
export LC_ALL=C

usage() {
    cat >&2 <<EOF
Usage: $0 NEW_OUTPUT_DIRECTORY
       $0 --report-only EXISTING_OUTPUT_DIRECTORY

The first form runs the complete physical acceptance matrix and writes both
raw artifacts and report.md. The second form regenerates report.md from an
existing output directory without running measurements.

Optional measurement environment:
  PICO_ARGOS_RUN_SECONDS       Each paired capture (default: 60)
  PICO_ARGOS_PAIRS             Interleaved pairs per scenario (default: 5)
  PICO_ARGOS_ONE_HOUR_SECONDS  Stability capture (default: 3600; 0 disables)
EOF
}

report_only=false
case ${1:-} in
    --help|-h)
        usage
        exit 0
        ;;
    --report-only)
        report_only=true
        shift
        ;;
esac
if (($# != 1)); then
    usage
    exit 2
fi

output_root=$1
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
acceptance_runner="$script_dir/run-acceptance.sh"
temporary_log=
cleanup() {
    if [[ -n $temporary_log &&
        $temporary_log == "${TMPDIR:-/tmp}"/pico-argos-acceptance.*.log ]]; then
        rm -f -- "$temporary_log"
    fi
}
trap cleanup EXIT

acceptance_exit=0
if [[ $report_only == false ]]; then
    if [[ -e $output_root ]]; then
        echo "Output path already exists: $output_root" >&2
        exit 1
    fi
    pairs=${PICO_ARGOS_PAIRS:-5}
    run_seconds=${PICO_ARGOS_RUN_SECONDS:-60}
    steady_seconds=${PICO_ARGOS_ONE_HOUR_SECONDS:-3600}
    if [[ $pairs =~ ^[0-9]+$ && $run_seconds =~ ^[0-9]+$ &&
        $steady_seconds =~ ^[0-9]+$ ]]; then
        capture_seconds=$((2 * 5 * pairs * 2 * run_seconds + steady_seconds))
        printf 'The configured matrix contains at least %d seconds of timed capture.\n' \
            "$capture_seconds"
    fi
    echo 'The runner will temporarily stage performance plugins and toggle pico-argos.'
    echo 'It does not install the extension or log out of the current session.'
    temporary_log=$(mktemp "${TMPDIR:-/tmp}/pico-argos-acceptance.XXXXXX.log")
    set +e
    "$acceptance_runner" "$output_root" 2>&1 | tee "$temporary_log"
    acceptance_exit=${PIPESTATUS[0]}
    set -e
    if [[ ! -d $output_root ]]; then
        echo 'Acceptance stopped before it could create an output directory.' >&2
        exit "$acceptance_exit"
    fi
    mv -- "$temporary_log" "$output_root/acceptance.log"
    temporary_log=
elif [[ ! -d $output_root ]]; then
    echo "Report input is not a directory: $output_root" >&2
    exit 1
fi
output_root=$(cd "$output_root" && pwd)

for command_name in awk du find jq sort; do
    command -v "$command_name" >/dev/null || {
        echo "Missing report command: $command_name" >&2
        exit 1
    }
done

number() {
    local value=$1
    local places=${2:-3}
    if [[ $value == null || -z $value ]]; then
        printf 'n/a'
    else
        printf "%.*f" "$places" "$value"
    fi
}

milliseconds() {
    local value=$1
    if [[ $value == null || -z $value ]]; then
        printf 'n/a'
    else
        awk -v nanoseconds="$value" 'BEGIN { printf "%.3f", nanoseconds / 1000000 }'
    fi
}

render_report() {
    local result_file="$output_root/result.json"
    local measurement=full-acceptance
    if [[ -f $result_file ]]; then
        measurement=$(jq -r '.measurement // "full-acceptance"' "$result_file")
    fi
    local verdict=INCOMPLETE
    local verdict_explanation='The matrix did not produce result.json. Read acceptance.log for the stopping condition.'
    local complete_evidence=false
    if [[ -f $result_file && -f $output_root/monitor-state.json &&
        -f $output_root/steady-state-analysis.json ]] &&
        jq -e '
            (.physical | length) == 2 and
            all(.physical[]; .refreshRate >= 119.5 and .refreshRate <= 120.5)
        ' "$output_root/monitor-state.json" >/dev/null &&
        jq -e '.oneHourSeconds >= 3600' "$result_file" >/dev/null; then
        complete_evidence=true
    fi
    if [[ -f $result_file && $measurement == redraw-ab ]]; then
        local focused_decision
        focused_decision=$(jq -r '.decision // "legacy"' "$result_file")
        case $focused_decision in
            no-material-effect)
                verdict='NO MATERIAL REDRAW EFFECT'
                verdict_explanation='The entire 95% confidence interval is inside the focused practical-effect margin, with no added freeze-like pauses.'
                ;;
            material-regression)
                verdict='MATERIAL REDRAW REGRESSION'
                verdict_explanation='The entire 95% confidence interval attributes a material delivered-FPS regression to the explicit redraw branch.'
                ;;
            material-improvement)
                verdict='MATERIAL REDRAW IMPROVEMENT'
                verdict_explanation='The entire 95% confidence interval attributes a material delivered-FPS improvement to the explicit redraw branch.'
                ;;
            freeze-regression)
                verdict='REDRAW FREEZE REGRESSION'
                verdict_explanation='The explicit redraw captures introduced more presentation gaps of at least 50 ms than the label-only captures.'
                ;;
            inconclusive)
                verdict='INCONCLUSIVE'
                verdict_explanation="The short run's 95% confidence interval crosses a practical-effect boundary; the report does not force a yes/no claim."
                ;;
            legacy)
                if jq -e '.passed == true' "$result_file" >/dev/null; then
                    verdict='FOCUSED A/B PASS'
                    verdict_explanation='The legacy focused mean-FPS gate passed.'
                else
                    verdict='FOCUSED A/B FAIL'
                    verdict_explanation='The legacy focused mean-FPS gate failed.'
                fi
                ;;
        esac
    elif [[ -f $result_file && $complete_evidence == true ]]; then
        if jq -e '.passed == true' "$result_file" >/dev/null; then
            verdict=PASS
            verdict_explanation='Every paired frame-rate comparison and the enabled steady-state gate passed.'
        else
            verdict=FAIL
            verdict_explanation='At least one paired frame-rate comparison or the enabled steady-state gate failed.'
        fi
    elif [[ -f $result_file ]]; then
        verdict_explanation='Paired diagnostics may be available, but the dual-120-Hz layout and one-hour stability evidence required for full acceptance are not both present.'
    fi

    printf '# pico-argos physical performance report\n\n'
    printf 'Overall result: **%s**\n\n' "$verdict"
    printf '%s\n\n' "$verdict_explanation"
    if [[ $measurement == redraw-ab ]]; then
        printf 'This focused result isolates the explicit redraw branch in one live Shell; it does not replace the full '
        printf 'dual-monitor matrix or one-hour stability acceptance.\n\n'
    else
        printf 'This is physical acceptance evidence only when the run completed on exactly two active 120 Hz monitors. '
        printf 'A failed or incomplete result must not be described as a no-regression result.\n\n'
    fi

    printf '## Test identity\n\n'
    mapfile -t environment_files < <(
        find "$output_root" -mindepth 2 -maxdepth 2 -type f \
            -name environment.json -print | sort)
    if ((${#environment_files[@]} > 0)); then
        local environment=${environment_files[0]}
        printf '| Field | Value |\n|---|---|\n'
        jq -r '
            ["Commit", .commit],
            ["Package SHA-256", .packageSha256],
            ["GNOME Shell", .shellVersion],
            ["GJS", .gjsVersion],
            ["Power profile", .powerProfile],
            ["Shell PID at first capture", (.shellPid | tostring)] |
            "| \(.[0]) | `\(.[1])` |"
        ' "$environment"
        printf '\n'
    else
        printf 'No completed capture supplied environment metadata.\n\n'
    fi

    printf '## Monitor layout\n\n'
    if [[ -f $output_root/monitor-state.json ]]; then
        printf '| Connector | Resolution | Refresh | Scale | VRR metadata |\n'
        printf '|---|---:|---:|---:|---|\n'
        jq -r '
            .physical[] |
            "| `\(.connector)` | \(.width)x\(.height) | " +
            "\(.refreshRate) Hz | \(.preferredScale) | " +
            "\(.variableRefreshRate // "not reported") |"
        ' "$output_root/monitor-state.json"
        if [[ $measurement == redraw-ab ]]; then
            printf '\nThe focused redraw A/B records the active physical layout but does not require two monitors.\n\n'
        else
            printf '\nThe acceptance precondition requires exactly two rows, each between 119.5 and 120.5 Hz.\n\n'
        fi
    else
        printf 'The dual-120-Hz precondition did not produce monitor-state.json.\n\n'
    fi

    printf '## Method and gate\n\n'
    if [[ $measurement == redraw-ab ]]; then
        local practical_margin
        practical_margin=$(jq -r '.practicalMarginPercent // "n/a"' "$result_file")
        printf 'The extension and the same live plugin set remain enabled in both roles. The baseline writes changed label '
        printf 'text and relies on normal Clutter damage; the scenario performs the identical write and additionally calls '
        printf '`queue_redraw()` on the panel button. At least five interleaved pairs alternate order to reduce time and '
        printf 'temperature bias. The quick decision uses the Student-t 95%% confidence interval and a practical ±%s%% margin: ' \
            "$practical_margin"
        printf 'wholly below is a material regression, wholly above is a material improvement, wholly inside is no material '
        printf 'effect, and crossing a boundary is inconclusive. Freeze-like pauses are checked separately.\n\n'
        printf 'Configured capture: %s pairs × two roles × %s seconds = %s seconds of timed measurement.\n\n' \
            "$(jq -r '.pairedRuns' "$result_file")" \
            "$(jq -r '.runSeconds' "$result_file")" \
            "$(jq -r '.pairedRuns * 2 * .runSeconds' "$result_file")"
        if [[ -f $result_file ]]; then
            printf 'Enabled plugins: `%s`.\n\n' \
                "$(jq -r '.plugins | join("`, `")' "$result_file")"
        fi
    else
        printf 'Each scenario is compared with the extension-disabled baseline in at least five paired, interleaved runs. '
        printf 'Pair order alternates to reduce time-order and temperature bias. The primary gate passes when the absolute '
        printf 'mean paired delivered-FPS change is at most 0.1%%. The Student-t 95%% confidence interval describes uncertainty; '
        printf 'whether it contains zero is informative but is not a separate gate.\n\n'
        printf 'The `summary` mode measures ordinary bounded diagnostics overhead; `off` disables ongoing collection. '
        printf 'The scenarios are no plugins, a semantic no-op stream, changing text, recurring one-shot launches, and the '
        printf 'five-plugin reference workload.\n\n'
    fi

    printf '## Paired comparison results\n\n'
    printf '| Diagnostics | Scenario | Pairs | Baseline FPS | Scenario FPS | Mean change | 95%% CI | Long intervals / 10k (B / S) | 0.1%% mean gate |\n'
    printf '|---|---|---:|---:|---:|---:|---:|---:|---|\n'
    local mode scenario comparison values
    local paired baseline_fps scenario_fps change ci_low ci_high long_baseline long_scenario passed
    for mode in summary off; do
        for scenario in empty constant changing oneshot full redraw; do
            comparison="$output_root/$mode-$scenario-comparison.json"
            [[ -f $comparison ]] || continue
            values=$(jq -r '[
                .pairedRuns,
                .baselineMeanFramesPerSecond,
                .scenarioMeanFramesPerSecond,
                .meanChangePercent,
                .confidence95Percent.low,
                .confidence95Percent.high,
                .meanLongIntervalsPerTenThousand.baseline,
                .meanLongIntervalsPerTenThousand.scenario,
                .frameRateGate.passed
            ] | @tsv' "$comparison")
            IFS=$'\t' read -r paired baseline_fps scenario_fps change ci_low ci_high \
                long_baseline long_scenario passed <<<"$values"
            printf '| %s | %s | %s | %s | %s | %s%% | %s to %s%% | %s / %s | %s |\n' \
                "$mode" "$scenario" "$paired" "$(number "$baseline_fps")" \
                "$(number "$scenario_fps")" "$(number "$change" 6)" \
                "$(number "$ci_low" 6)" "$(number "$ci_high" 6)" \
                "$(number "$long_baseline")" "$(number "$long_scenario")" \
                "$([[ $passed == true ]] && printf PASS || printf FAIL)"
        done
    done
    printf '\nA positive change means the scenario delivered more frames than its paired baseline; a negative change means fewer. '
    printf 'On VRR-capable outputs, presentation-time may report a zero refresh period, making long-interval counts unavailable '
    printf 'even though delivered FPS and the paired comparison remain valid.\n\n'
    if [[ $measurement == redraw-ab ]]; then
        printf 'The final focused verdict uses the confidence-interval decision described above; the 0.1%% mean-only column is '
        printf 'retained as the stricter release metric and does not override an `INCONCLUSIVE` quick result.\n\n'
    fi

    printf '### Paired changes\n\n'
    for mode in summary off; do
        for scenario in empty constant changing oneshot full redraw; do
            comparison="$output_root/$mode-$scenario-comparison.json"
            [[ -f $comparison ]] || continue
            printf -- '- `%s/%s`: ' "$mode" "$scenario"
            jq -r '.pairedFrameRateChangesPercent |
                map((. * 1000000 | round) / 1000000 | tostring) |
                join("%, ") + "%"' "$comparison"
        done
    done
    printf '\nThese are the scenario-versus-baseline percentage changes for each pair. Large variation widens the confidence interval.\n\n'

    mapfile -t summary_files < <(
        find "$output_root" -mindepth 2 -maxdepth 2 -type f \
            -name presentation-summary.json -print | sort)

    printf '## Frame pacing and visible-freeze discrimination\n\n'
    printf '| Diagnostics | Scenario | Pair | Role | Nominal cadence | Delayed / 10k | Estimated missed refreshes | Multi-refresh gaps | Freeze-like gaps | Worst gap | Longest delayed run | Interpretation |\n'
    printf '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|\n'
    local summary environment pacing_row cadence_source cadence_ns cadence_fps
    local delayed_rate estimated_missed multi_gaps freeze_gaps maximum_gap
    local maximum_gap_periods maximum_cluster experience
    local pacing_capture_count=0
    for summary in "${summary_files[@]}"; do
        environment="$(dirname "$summary")/environment.json"
        [[ -f $environment ]] || continue
        jq -e '.framePacing != null' "$summary" >/dev/null || continue
        pacing_capture_count=$((pacing_capture_count + 1))
        pacing_row=$(jq -r --slurpfile environment "$environment" '[
            $environment[0].diagnosticsMode,
            $environment[0].scenario,
            $environment[0].pair,
            $environment[0].runRole,
            (.framePacing.cadenceSource // "not-recorded"),
            (.framePacing.nominalIntervalNanoseconds // null),
            (.framePacing.nominalFramesPerSecond // null),
            (.framePacing.delayedIntervals.perTenThousand // null),
            (.framePacing.estimatedMissedRefreshes // null),
            (.framePacing.multiRefreshGaps.count // null),
            (.framePacing.freezeLikePauses.count // null),
            (.framePacing.maximumGapNanoseconds // .intervalNanoseconds.maximum),
            (.framePacing.maximumGapRefreshPeriods // null),
            (.framePacing.delayedIntervals.maximumClusterLength // null),
            (.framePacing.experienceClass // "not-recorded")
        ] | @tsv' "$summary")
        IFS=$'\t' read -r diagnostics scenario pair role cadence_source \
            cadence_ns cadence_fps delayed_rate estimated_missed multi_gaps \
            freeze_gaps maximum_gap maximum_gap_periods maximum_cluster \
            experience <<<"$pacing_row"
        printf '| %s | %s | %s | %s | %s ms / %s Hz `%s` | %s | %s | %s | %s | %s ms / %s refreshes | %s | `%s` |\n' \
            "$diagnostics" "$scenario" "$pair" "$role" \
            "$(milliseconds "$cadence_ns")" "$(number "$cadence_fps")" \
            "$cadence_source" "$(number "$delayed_rate")" \
            "$estimated_missed" "$multi_gaps" "$freeze_gaps" \
            "$(milliseconds "$maximum_gap")" \
            "$(number "$maximum_gap_periods" 2)" "$maximum_cluster" \
            "$experience"
    done
    if ((pacing_capture_count == 0)); then
        printf '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | `not-recorded` |\n'
    fi
    printf '\nA delayed interval exceeds 1.5 observed refresh periods; a multi-refresh gap exceeds 2.5. '
    printf 'A **freeze-like gap** is an objective presentation gap of at least 50 ms. At 120 Hz that spans about six refresh periods, '
    printf 'unlike an isolated 16.7 ms interval, which misses one refresh but normally does not look like a freeze. '
    printf 'The interpretation deliberately distinguishes `misses-without-freeze-like-pauses` from `freeze-like-pauses-detected`; '
    printf 'it is descriptive and does not replace the strict delivered-FPS gate.\n\n'
    printf 'When Wayland supplies a positive presentation refresh period, the cadence source is `presentation-feedback`. '
    printf 'When it reports zero on a VRR-capable output, `observed-fastest-decile` estimates the active cadence from the fastest '
    printf '10%% of this continuously committing probe. That fallback is useful for stutter diagnosis but is not authoritative refresh metadata.\n\n'

    printf '## One-hour steady state\n\n'
    local steady="$output_root/steady-state-analysis.json"
    if [[ -f $steady ]]; then
        printf '| Measure | Value | Meaning |\n|---|---:|---|\n'
        jq -r '
            ["Verdict", (if .passed then "PASS" else "FAIL" end), "All enabled stability gates"],
            ["Measured duration", ((.durationSeconds / 3600 | tostring) + " hours"), "Continuous full workload"],
            ["RSS samples", (.sampleCount | tostring), "At least 30 are required"],
            ["Plugin set stable", (.pluginSetStable | tostring), "Same enabled plugin IDs before and after"],
            ["Actor counts stable", (.actorMutations.stable | tostring), "No actor creation or destruction during the run"],
            ["RSS minimum", ((.shellRssKiB.minimum / 1024 | tostring) + " MiB"), "Smallest Shell resident set"],
            ["RSS maximum", ((.shellRssKiB.maximum / 1024 | tostring) + " MiB"), "Largest Shell resident set"],
            ["Quarter-median change", ((.shellRssKiB.medianChange / 1024 | tostring) + " MiB"), "Last quarter minus first quarter"],
            ["Regression slope", ((.shellRssKiB.regressionSlopePerHour / 1024 | tostring) + " MiB/hour"), "Descriptive linear trend"],
            ["Monotonically growing", (.shellRssKiB.monotonicallyGrowing | tostring), "Must be false"] |
            "| \(.[0]) | \(.[1]) | \(.[2]) |"
        ' "$steady"
        printf '\nThe stability gate checks a stable plugin set, stable actor creation/destruction counts, and RSS that is not '
        printf 'monotonically non-decreasing. The slope and quarter medians add context but do not independently fail the gate.\n\n'
    elif [[ $measurement == redraw-ab ]]; then
        printf 'A stability phase is outside this focused branch comparison.\n\n'
    elif [[ -f $result_file ]] && [[ $(jq -r '.oneHourSeconds' "$result_file") == 0 ]]; then
        printf 'The stability phase was explicitly disabled, so this run is not full physical acceptance.\n\n'
    else
        printf 'No completed steady-state analysis is available.\n\n'
    fi

    printf '## Individual captures\n\n'
    printf '| Diagnostics | Scenario | Pair | Role | FPS | Presented | Discarded | Interval p95 / p99 (ms) | Callback p95 (ms) | Submit-to-present p95 (ms) | Long / 10k |\n'
    printf '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n'
    local summary environment row diagnostics pair role fps presented discarded
    local interval_p95 interval_p99 callback_p95 submission_p95 long_per_ten_thousand
    for summary in "${summary_files[@]}"; do
        environment="$(dirname "$summary")/environment.json"
        [[ -f $environment ]] || continue
        row=$(jq -r --slurpfile environment "$environment" '[
            $environment[0].diagnosticsMode,
            $environment[0].scenario,
            $environment[0].pair,
            $environment[0].runRole,
            .deliveredFramesPerSecond,
            .presentedFrames,
            .discardedFrames,
            .intervalNanoseconds.p95,
            .intervalNanoseconds.p99,
            .callbackLatencyNanoseconds.p95,
            .submissionToPresentationNanoseconds.p95,
            .longIntervals.perTenThousand
        ] | @tsv' "$summary")
        IFS=$'\t' read -r diagnostics scenario pair role fps presented discarded \
            interval_p95 interval_p99 callback_p95 submission_p95 \
            long_per_ten_thousand <<<"$row"
        printf '| %s | %s | %s | %s | %s | %s | %s | %s / %s | %s | %s | %s |\n' \
            "$diagnostics" "$scenario" "$pair" "$role" "$(number "$fps")" \
            "$presented" "$discarded" "$(milliseconds "$interval_p95")" \
            "$(milliseconds "$interval_p99")" "$(milliseconds "$callback_p95")" \
            "$(milliseconds "$submission_p95")" \
            "$(number "$long_per_ten_thousand")"
    done
    printf '\nInterval percentiles describe spacing between presented frames. Callback latency is probe submission to feedback '
    printf 'receipt; submit-to-present uses the compositor presentation clock when it is `CLOCK_MONOTONIC`. Discarded frames '
    printf 'are compositor-rejected probe submissions, while delivered FPS is computed only from actual presentation timestamps.\n\n'

    printf '## GNOME Shell resource samples\n\n'
    printf '| Diagnostics | Scenario | Pair | Role | Mean CPU | Mean RSS | RSS range | Mean voluntary / involuntary switches per second |\n'
    printf '|---|---|---|---|---:|---:|---:|---:|\n'
    local capture_dir pidstat resource cpu_mean rss_mean rss_min rss_max voluntary involuntary
    for summary in "${summary_files[@]}"; do
        capture_dir=$(dirname "$summary")
        environment="$capture_dir/environment.json"
        pidstat="$capture_dir/pidstat.txt"
        [[ -f $environment && -f $pidstat ]] || continue
        IFS=$'\t' read -r diagnostics scenario pair role < <(
            jq -r '[.diagnosticsMode, .scenario, .pair, .runRole] | @tsv' \
                "$environment")
        resource=$(awk '
            $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $NF == "gnome-shell" {
                cpu += $8;
                rss += $13;
                voluntary += $15;
                involuntary += $16;
                if (count == 0 || $13 < rss_min)
                    rss_min = $13;
                if (count == 0 || $13 > rss_max)
                    rss_max = $13;
                count++;
            }
            END {
                if (count > 0) {
                    printf "%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f", \
                        cpu / count, rss / count / 1024, rss_min / 1024, \
                        rss_max / 1024, voluntary / count, involuntary / count;
                }
            }
        ' "$pidstat")
        [[ -n $resource ]] || continue
        IFS=$'\t' read -r cpu_mean rss_mean rss_min rss_max voluntary involuntary \
            <<<"$resource"
        printf '| %s | %s | %s | %s | %s%% | %s MiB | %s–%s MiB | %s / %s |\n' \
            "$diagnostics" "$scenario" "$pair" "$role" "$cpu_mean" \
            "$rss_mean" "$rss_min" "$rss_max" "$voluntary" "$involuntary"
    done
    printf '\nThese are per-second samples for the GNOME Shell process, which includes compositor work and the timing probe\047s '
    printf 'effect on Shell activity. Plugin child-process CPU is not included. CPU and RSS are supporting evidence; the '
    printf 'paired delivered-FPS comparison is the acceptance gate.\n\n'

    printf '## Artifact guide\n\n'
    printf 'The output directory occupies `%s` and contains `%s` timed capture directories.\n\n' \
        "$(du -sh "$output_root" | awk '{print $1}')" "${#summary_files[@]}"
    printf '| Artifact | Contents and interpretation |\n|---|---|\n'
    printf '| `report.md` | This rendered report. Regenerate it with `--report-only`. |\n'
    printf '| `result.json` | Machine-readable overall verdict and configured durations. |\n'
    printf '| `*-comparison.json` | Aggregate FPS means, per-pair changes, 95%% confidence interval, and gate verdict. |\n'
    printf '| `presentation-summary.json` | One capture\047s FPS, latency percentiles, refresh metadata, discarded frames, long intervals, and freeze-like-gap profile. |\n'
    printf '| `presentation.ndjson` | Raw bounded `wp_presentation_feedback` events used to calculate the summary. |\n'
    printf '| `environment.json` | Commit, package hash, versions, power profile, role, scenario, and timing identity. |\n'
    printf '| `summary-before.json` / `summary-after.json` | Sanitized pico-argos diagnostics bracketing the capture. |\n'
    printf '| `process-memory.tsv` | GNOME Shell and direct-child RSS/thread samples at ten-second intervals. |\n'
    printf '| `pidstat.txt` | Per-second Shell CPU, scheduling, faults, context switches, and RSS evidence. |\n'
    printf '| `perf-stat.txt` | Best-effort kernel performance counters when `perf` was available and permitted. |\n'
    printf '| `gnome-shell.journal.txt` | Journal window for warnings and errors during that capture. |\n'
    printf '| `acceptance.log` | Runner output, especially useful for an incomplete run. |\n\n'
    printf 'Raw artifacts are retained so the verdict can be audited without rerunning the multi-hour matrix. '
    printf 'Ordinary plugin output and environment secrets are not included.\n'
}

report_path="$output_root/report.md"
render_report | tee "$report_path"

if [[ -f $output_root/result.json ]] &&
    jq -e '.measurement == "redraw-ab" and .passed == true' \
        "$output_root/result.json" >/dev/null; then
    exit "$acceptance_exit"
fi
if [[ -f $output_root/result.json && -f $output_root/monitor-state.json &&
    -f $output_root/steady-state-analysis.json ]] &&
    jq -e '
        (.physical | length) == 2 and
        all(.physical[]; .refreshRate >= 119.5 and .refreshRate <= 120.5)
    ' "$output_root/monitor-state.json" >/dev/null &&
    jq -e '.oneHourSeconds >= 3600 and .passed == true' \
        "$output_root/result.json" >/dev/null; then
    exit "$acceptance_exit"
fi
exit 1
