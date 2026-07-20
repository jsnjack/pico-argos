# Dependabot reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/dependabot/` and
provide `GITHUB_TOKEN` plus `GITHUB_REPOSITORY=owner/name` in the Shell session
environment. The token needs read access to Dependabot alerts and is placed in
an HTTP header inside the child process, never in argv or protocol output.
