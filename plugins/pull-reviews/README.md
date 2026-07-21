# Pull-review reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/pull-reviews/` and
provide `GITHUB_TOKEN`, `GITHUB_USER`, and a comma-separated
`GITHUB_REPOSITORIES`. `GITHUB_ISSUE_REPOSITORY` optionally changes the legacy
`surfly/it` target used by the Assigned and New issues links. One GraphQL search
counts non-draft open pull requests; the token is sent only in an in-process
HTTP header. The hammer, palm-tree all-clear state, menu wording, and grouping
match the original Argos extension.
