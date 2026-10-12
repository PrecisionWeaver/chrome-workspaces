# Configuration

Optional fields in `~/.chrome-workspaces/config.json` (preserved by `setup`). Restart the helper after editing.

An entry the helper can't use (an unknown key, a wrong type, a repo name that isn't `owner/name`) is ignored and named in Settings' **Getting started** checklist and in `helper.log`. Broken JSON stops the helper, and the log says which file.

| Field | Purpose |
|---|---|
| `promptsFile` | Prompt note. Default `~/.chrome-workspaces/prompts.md`, which `setup` seeds from `prompts.example.md` if you have none. A standalone `PR-URL`, a PR link ending `/pull/XXXX`, and `PROJ-XXX` are filled in from the PR. Each `**Heading**` starts a section; each `- ` bullet is a prompt. |
| `claudeCommand` | The command that starts claude, e.g. `"hr"` for a wrapper that passes claude's arguments through. A bare command name; if the login shell can't find it, `claude` runs instead. Default `"claude"`. |
| `defaultModel` | `claude --model` for workspaces that pick none, e.g. `"opus"`. Unset leaves it to claude. |
| `pricing` | Dollars per million tokens by model family for the cost estimates, e.g. `{ "opus": { "input": 15, "output": 75 } }`. Merged over built-in estimates. |
| `jiraBaseUrl` | Your Jira site, e.g. `"https://acme.atlassian.net"`. With it, a workspace's ticket opens from its right-click menu and `⌘K`, and a review request shows an **Open in Jira** button. Only an `https` address is accepted. |
| `limits` | When Settings warns: `{ "memoryWarnMb": 4096, "idleServerHours": 4 }`. Both are optional. |
| `repoRoots` | Folders whose git repos the **Repo** picker lists, e.g. `["~/code"]`. Default none, so the picker is empty until you set it. |
| `repoDirs` | Starting directory for PR workspaces by repo, e.g. `{ "acme/web-app": "~/code/web-app" }`. Unlisted repos use the default. These repos also get your own open PRs listed under review requests. |
| `watchRepos` | Repos whose open PRs (yours included) appear under review requests, for repos that don't request reviewers, e.g. `["acme/api"]`. |
