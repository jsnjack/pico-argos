# Pull-review reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/pull-reviews/` and
provide `GITHUB_TOKEN`, `GITHUB_USER`, and a comma-separated
`GITHUB_REPOSITORIES`. `GITHUB_ISSUE_REPOSITORY` optionally changes the legacy
`surfly/it` target used by the Assigned and New issues links. One GraphQL search
counts non-draft open pull requests and returns at most five actionable pull
request titles; the token is sent only in an in-process HTTP header. Adwaita
symbolic icons distinguish the all-clear and review-needed states. The existing
review, assignment, authored-pull-request, and issue destinations remain in the
menu.
