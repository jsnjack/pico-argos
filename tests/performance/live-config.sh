# SPDX-License-Identifier: GPL-3.0-or-later
# shellcheck shell=bash
#
# Sourced by the physical acceptance runners. They change the live
# config.json, so they back it up first and restore it exactly on exit.

live_config_file="${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/pico-argos/config.json"
live_config_backup_file=
live_config_existed=false

# Copies the current config.json into the run's private output directory.
live_config_backup() {
    live_config_backup_file="$1/original-config.json"
    if [[ -f $live_config_file ]]; then
        cp -p -- "$live_config_file" "$live_config_backup_file"
        live_config_existed=true
    fi
}

# Puts back the backed-up file, or removes the one the run created.
live_config_restore() {
    [[ -n $live_config_backup_file ]] || return 0
    if [[ $live_config_existed == true ]]; then
        cp -p -- "$live_config_backup_file" "$live_config_file.restore"
        mv -- "$live_config_file.restore" "$live_config_file"
    else
        rm -f -- "$live_config_file"
    fi
}

# Applies one jq filter (with its --arg/--argjson options) to config.json and
# replaces the file atomically, so the extension never reads a partial file.
live_config_set() {
    local current='{}'
    [[ -f $live_config_file ]] && current=$(<"$live_config_file")
    install -d -m 700 -- "$(dirname "$live_config_file")"
    jq "$@" <<<"$current" >"$live_config_file.new"
    chmod 600 "$live_config_file.new"
    mv -- "$live_config_file.new" "$live_config_file"
}
