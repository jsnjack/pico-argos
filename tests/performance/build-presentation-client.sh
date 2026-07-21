#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

if (($# != 1)); then
    echo "Usage: $0 OUTPUT" >&2
    exit 2
fi
for command_name in cc pkg-config wayland-scanner; do
    command -v "$command_name" >/dev/null || {
        echo "Missing build dependency: $command_name" >&2
        exit 1
    }
done
pkg-config --exists wayland-client || {
    echo 'Missing wayland-client development files' >&2
    exit 1
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/pico-argos-presentation-build.XXXXXX")
cleanup() {
    if [[ $temporary_dir == "${TMPDIR:-/tmp}"/pico-argos-presentation-build.* ]]; then
        rm -rf -- "$temporary_dir"
    fi
}
trap cleanup EXIT

find_protocol() {
    local relative=$1
    local candidate
    for candidate in \
        "/usr/share/wayland-protocols/$relative" \
        "/usr/local/share/wayland-protocols/$relative" \
        "/usr/share/qt6/wayland/protocols/$relative"; do
        if [[ -f $candidate ]]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

xdg_shell=$(find_protocol 'stable/xdg-shell/xdg-shell.xml' ||
    find_protocol 'xdg-shell/xdg-shell.xml')
presentation=$(find_protocol 'stable/presentation-time/presentation-time.xml' ||
    find_protocol 'presentation-time/presentation-time.xml')
for protocol in xdg-shell presentation-time; do
    source_path=$xdg_shell
    if [[ $protocol == presentation-time ]]; then
        source_path=$presentation
    fi
    wayland-scanner client-header "$source_path" \
        "$temporary_dir/$protocol-client-protocol.h"
    wayland-scanner private-code "$source_path" \
        "$temporary_dir/$protocol-client-protocol.c"
done

read -r -a wayland_flags <<<"$(pkg-config --cflags --libs wayland-client)"
cc -std=c11 -O2 -Wall -Wextra -Werror \
    -I"$temporary_dir" \
    "$script_dir/presentation-client.c" \
    "$temporary_dir/xdg-shell-client-protocol.c" \
    "$temporary_dir/presentation-time-client-protocol.c" \
    "${wayland_flags[@]}" \
    -o "$1"
