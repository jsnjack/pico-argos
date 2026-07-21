#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
uuid=pico-argos@jsnjack.github.io
actor_uuid=pico-argos-actor-test@jsnjack.github.io
package="$repo_root/dist/$uuid.shell-extension.zip"

for required in cc dbus-run-session gdbus gjs glib-compile-schemas gnome-extensions \
    gnome-shell gsettings jq pgrep pkg-config rg unzip wayland-scanner; do
    if ! command -v "$required" >/dev/null 2>&1; then
        echo "Missing required integration command: $required" >&2
        exit 1
    fi
done
if [[ $(gnome-shell --version) != 'GNOME Shell 50.'* ]]; then
    echo "Nested integration requires GNOME Shell 50" >&2
    exit 1
fi
if [[ ! -s "$package" ]]; then
    echo "Build the extension first with: make package" >&2
    exit 1
fi

test_root=$(mktemp -d "${TMPDIR:-/tmp}/pico-argos-integration.XXXXXX")
cleanup() {
    if [[ $test_root == "${TMPDIR:-/tmp}"/pico-argos-integration.* ]]; then
        rm -rf -- "$test_root"
    fi
}
trap cleanup EXIT

presentation_client="$test_root/presentation-client"
"$repo_root/tests/performance/build-presentation-client.sh" "$presentation_client"

extension_dir="$test_root/data/gnome-shell/extensions/$uuid"
actor_dir="$test_root/data/gnome-shell/extensions/$actor_uuid"
plugin_dir="$test_root/config/pico-argos/plugins/smoke"
mkdir -p "$extension_dir" "$actor_dir/lib" "$plugin_dir" \
    "$test_root/cache" "$test_root/runtime"
chmod 700 "$test_root/runtime"
unzip -q "$package" -d "$extension_dir"
glib-compile-schemas --strict "$extension_dir/schemas"
cp "$repo_root/tests/fixtures/plugins/smoke/plugin.json" "$plugin_dir/"
cp "$repo_root/tests/fixtures/plugins/smoke/run" "$plugin_dir/"
chmod 700 "$plugin_dir/run"
cp "$repo_root/tests/integration/actor-harness/metadata.json" "$actor_dir/"
cp "$repo_root/tests/integration/actor-harness/extension.js" "$actor_dir/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/diagnostics.js" "$actor_dir/lib/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/manifest.js" "$actor_dir/lib/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/plugin-indicator.js" "$actor_dir/lib/"
cp "$repo_root/pico-argos@jsnjack.github.io/lib/trace.js" "$actor_dir/lib/"

export PICO_ARGOS_TEST_ROOT=$test_root
export PICO_ARGOS_REPO_ROOT=$repo_root
export PICO_ARGOS_PRESENTATION_CLIENT=$presentation_client
dbus-run-session -- "$repo_root/tests/integration/nested-session.sh"

echo "ok - nested GNOME Shell lifecycle, reload, diagnostics, preferences, and actors"
