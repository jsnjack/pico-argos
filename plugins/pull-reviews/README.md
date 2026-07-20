# Pull-review reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/pull-reviews/` and
provide `GITHUB_TOKEN`, `GITHUB_USER`, and a comma-separated
`GITHUB_REPOSITORIES`. One GraphQL search counts non-draft open pull requests;
the token is sent only in an in-process HTTP header.
