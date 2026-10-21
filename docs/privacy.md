# Privacy

Chrome Workspaces runs on your Mac and has no server of its own. It sends nothing anywhere except as listed here.

## What leaves your machine

| What                                                                                   | When                                                                          | Where to                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| `gh` searches and queries for pull requests, their details, review comments and checks | Every 5 minutes, on ↻, and when you open a PR or a workspace's source control | GitHub, as the account `gh` is signed in to |
| `git fetch` of this app's own repository                                               | When you press **Check for updates**                                          | This copy's `origin`                        |

Opening a Jira ticket, a PR or a workspace's tabs is ordinary browsing in Chrome. `claude` itself talks to Anthropic as it always does; this app only starts it.

## What it reads on your machine

- The session files its own hook writes to `~/.chrome-workspaces/sessions/`, and the Claude Code transcripts they point to, for status, activity, token counts and costs. They are read, never written or copied.
- Git repositories that workspaces are in, and the folders in `repoRoots`.
- Your prompts file.

## What it keeps

Everything is under `~/.chrome-workspaces/`: the config, the workspace list, one small status file per Claude session (pruned after a month), recently closed workspaces, terminal scrollback (in memory only, gone when the helper restarts), files you drop into a terminal (deleted after a week), and the helper's log. The panel's own preferences live in Chrome's extension storage. `npm run uninstall -- --purge` deletes the folder.

## Who can reach the helper

Only this Mac: the helper listens on `127.0.0.1`. Its WebSockets accept only this extension, and its HTTP API needs the token in `~/.chrome-workspaces/token` (readable only by you). See [architecture.md](architecture.md#security-model).
