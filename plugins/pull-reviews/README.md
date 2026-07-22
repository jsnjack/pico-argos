# Pull-review reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/pull-reviews/` and
provide `GITHUB_TOKEN`, `GITHUB_USER`, and a comma-separated
`GITHUB_REPOSITORIES`. `GITHUB_ISSUE_REPOSITORY` optionally changes the legacy
`surfly/it` target used by the Assigned and New issues links. One GraphQL search
counts non-draft open pull requests with your review requested across every
repository the token can see — matching GitHub's own "All review requests"
list — and returns at most five actionable pull request titles; the token is
sent only in an in-process HTTP header. `GITHUB_REPOSITORIES` no longer scopes
the search itself; it only supplies the organization used by the My pull
requests link. Adwaita symbolic icons distinguish the all-clear and
review-needed states, and the panel count renders in superscript digits. The
existing review, assignment, authored-pull-request, and issue destinations
remain in the menu.
