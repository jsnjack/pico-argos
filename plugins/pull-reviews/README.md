# Pull-review reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/pull-reviews/`,
add its settings to the `plugins.pull-reviews` object of
`$XDG_CONFIG_HOME/pico-argos/config.json`, and provide `GITHUB_TOKEN` in the
Shell session environment:

```json
{
  "plugins": {
    "pull-reviews": {
      "user": "octocat",
      "repositories": ["example/project"],
      "issueRepository": "surfly/it"
    }
  }
}
```

| Key | Default | Accepted values |
|---|---|---|
| `user` | required | A GitHub login |
| `repositories` | required | An array of 1 to 20 `owner/name` strings |
| `issueRepository` | `"surfly/it"` | One `owner/name` string |

`issueRepository` is the target of the Assigned and New issues links. pico-argos
passes the object to the plugin as JSON in the `PICO_ARGOS_CONFIG` environment
variable; a missing or invalid value, or an unknown key, fails the refresh with
an error that names it. The token stays in the environment because it is a
secret.

One GraphQL search counts non-draft open pull requests with your review
requested across every repository the token can see — matching GitHub's own
"All review requests" list — and returns at most five actionable pull request
titles; the token is sent only in an in-process HTTP header. `repositories`
does not scope the search itself; its first entry only supplies the
organization used by the My pull requests link.

The all-clear state shows an Adwaita checkmark with no text; the review-needed
state drops the icon and renders `PR` followed by a superscript digit count
(e.g. `PR¹²`) in a monospace panel appearance, so the reserved width stays
constant as the count crosses digit boundaries. The existing review,
assignment, authored-pull-request, and issue destinations remain in the menu.
