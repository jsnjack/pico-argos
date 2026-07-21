# Dependabot reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/dependabot/` and
provide `GITHUB_TOKEN` plus `GITHUB_REPOSITORY=owner/name` in the Shell session
environment. The token needs read access to Dependabot alerts and is placed in
an HTTP header inside the child process, never in argv or protocol output.

The indicator remains hidden when no critical alert is open. Otherwise it uses
the Adwaita urgent-update symbolic icon with the alert count and lists up to
five affected packages before the link to all critical vulnerabilities.
