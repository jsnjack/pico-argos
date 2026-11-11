# Dependabot reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/dependabot/`, name
the repository in the `plugins.dependabot` object of
`$XDG_CONFIG_HOME/pico-argos/config.json`, and provide `GITHUB_TOKEN` in the
Shell session environment:

```json
{
  "plugins": {
    "dependabot": {
      "repository": "owner/name"
    }
  }
}
```

`repository` is required and is the only setting. pico-argos passes the object
to the plugin as JSON in the `PICO_ARGOS_CONFIG` environment variable; a
missing repository, a value without `owner/name` form, or an unknown key fails
the refresh with an error that names it. The token stays in the environment
because it is a secret. It needs read access to Dependabot alerts and is placed
in an HTTP header inside the child process, never in argv, settings, or
protocol output.

The indicator remains hidden when no critical alert is open. Otherwise it uses
the Adwaita urgent-update symbolic icon with the alert count and lists up to
five affected packages before the link to all critical vulnerabilities.
