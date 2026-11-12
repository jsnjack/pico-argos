#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
uuid=pico-argos@jsnjack.github.io
actor_uuid=pico-argos-actor-test@jsnjack.github.io
package="$repo_root/dist/$uuid.shell-extension.zip"

for required in cc dbus-run-session gdbus gjs gnome-extensions \
    gnome-shell jq pgrep pkg-config rg unzip wayland-scanner; do
    if ! command -v "$required" >/dev/null 2>&1; then
        echo "Missing required integration command: $required" >&2
        exit 1
    fi
done
if [[ $(gnome-shell --version) != 'GNOME Shell '5[01].* ]]; then
    echo "Nested integration requires GNOME Shell 50 or 51" >&2
    exit 1
fi
if [[ ! -s "$package" ]]; then
    echo "Build the extension first with: make package" >&2
    exit 1
fi

# A document portal sharing the desktop's runtime directory unmounts its doc
# filesystem, and Flatpak apps then fail to start. The private XDG_RUNTIME_DIR
# below prevents that; the check in cleanup fails the run if it happens anyway.
desktop_doc=/run/user/$(id -u)/doc
had_doc=
if mountpoint -q "$desktop_doc" 2>/dev/null; then
    had_doc=1
fi
check_desktop_doc() {
    if [[ -n $had_doc ]] && ! mountpoint -q "$desktop_doc"; then
        echo "$desktop_doc was unmounted during this run, so Flatpak apps cannot start." >&2
        echo "Restore it with: systemctl --user restart xdg-document-portal.service" >&2
        exit 1
    fi
}

test_root=$(mktemp -d "${TMPDIR:-/tmp}/pico-argos-integration.XXXXXX")
cleanup() {
    if [[ $test_root == "${TMPDIR:-/tmp}"/pico-argos-integration.* ]]; then
        # Activated portals can finish unmounting after the session bus exits.
        for _attempt in {1..50}; do
            if rm -rf --one-file-system -- "$test_root" 2>/dev/null; then
                check_desktop_doc
                return
            fi
            sleep 0.1
        done
        rm -rf --one-file-system -- "$test_root"
    fi
    check_desktop_doc
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

presentation_client="$test_root/presentation-client"
"$repo_root/tests/performance/build-presentation-client.sh" "$presentation_client"

extension_dir="$test_root/data/gnome-shell/extensions/$uuid"
actor_dir="$test_root/data/gnome-shell/extensions/$actor_uuid"
plugin_dir="$test_root/config/pico-argos/plugins/smoke"
mkdir -p "$extension_dir" "$actor_dir/lib" "$plugin_dir" \
    "$test_root/cache" "$test_root/runtime"
chmod 700 "$test_root/runtime"
unzip -q "$package" -d "$extension_dir"
cp "$repo_root/tests/fixtures/plugins/smoke/plugin.json" "$plugin_dir/"
cp "$repo_root/tests/fixtures/plugins/smoke/run" "$plugin_dir/"
chmod 700 "$plugin_dir/run"
cp "$repo_root/tests/integration/actor-harness/metadata.json" "$actor_dir/"
cp "$repo_root/tests/integration/actor-harness/extension.js" "$actor_dir/"
# The production stylesheet lets the harness assert computed severity colors.
cp "$repo_root/pico-argos@jsnjack.github.io/stylesheet.css" "$actor_dir/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/diagnostics.js" "$actor_dir/lib/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/manifest.js" "$actor_dir/lib/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/plugin-indicator.js" "$actor_dir/lib/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/trace.js" "$actor_dir/lib/"

export PICO_ARGOS_TEST_ROOT=$test_root
export PICO_ARGOS_REPO_ROOT=$repo_root
export PICO_ARGOS_PRESENTATION_CLIENT=$presentation_client
# Bus-activated services inherit the bus daemon's environment, not its clients'.
export XDG_CONFIG_HOME="$test_root/config"
export XDG_CACHE_HOME="$test_root/cache"
export XDG_DATA_HOME="$test_root/data"
export XDG_RUNTIME_DIR="$test_root/runtime"
export XDG_DATA_DIRS="/usr/local/share:/usr/share"
export GSETTINGS_BACKEND=keyfile
dbus-run-session -- "$repo_root/tests/integration/nested-session.sh"

echo "ok - nested GNOME Shell lifecycle, reload, diagnostics, preferences, and actors"
