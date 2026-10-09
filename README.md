# Chrome Workspaces

A Claude terminal for every Chrome window or tab group, docked in Chrome's side panel, with source control and pull-request review built in.

Each workspace is a regular Chrome window, or a tab group inside one, with your profile, logins, extensions, and DevTools, paired with a terminal running `claude`. Keep a task's tabs in its window or group and switch between workspaces with `⌃⇧←` / `⌃⇧→`.

```
+-----------------------------------------------------------+
|  Chrome tabs + toolbar                                    |
+------------+----------------------+-----------------------+
|  1 PROJ-12 |                      |                       |
|> 2 PROJ-13 |  terminal (claude)   |  web page             |
|  3 OPS-88  |                      |                       |
|  + New     |                      |                       |
|            |                      |                       |
|  Source    |                      |                       |
|  Reviews   |                      |                       |
+------------+----------------------+-----------------------+
```

`>` marks the workspace in view; the list, with Source control and Review requests below it, sits beside its terminal.

## Features

| | |
|---|---|
| **Command palette** | `⌘K` (or `Ctrl+K`), even from the terminal, opens one box that fuzzy-finds every workspace and review request and runs actions (new workspace, settings, refresh). `nw` finds *New workspace*. |
| **Switch** | `⌃⇧←` / `⌃⇧→` or click a workspace. All workspace windows share the size you last set, so switching swaps content in place. |
| **Create** | `+ New workspace` opens one view: a **Name**, the **Repo** to start in, the **Model** (`claude --model`), optional **Tabs** (one URL per line, opened with the workspace), a first message, and where it lives. Or run `devspace PROJ-1234`. A window that isn't a workspace offers to become one. |
| **Templates** | **Save current…** in the New workspace view keeps its repo, model, tabs, first message and window as a named template; pick one to fill the form in a click. |
| **First message** | **Blank**, **From prompt** (pick from your notes file; `PR-URL` and `PROJ-XXX` are filled in from the PR), or **From text** (type anything). The message runs once; reopening resumes the conversation. |
| **Window or group** | **New window**, or **This window**. Joining a window that already holds a workspace gives the new one its own tab group beside it, so several terminals can share a window. Pick one from the list or by clicking a tab in its group; its badge takes the group's color. Switching collapses the window's other groups and shows the new one's; expand any by hand and it stays that way until the next switch. Merging windows into tab groups keeps their workspaces. |
| **From a review request** | Clicking a review request opens the same view with the PR's details above it: branches, size, review and check status, labels, the description rendered as markdown, collapsed lists of the biggest files and latest commits, and its **review comments** (open threads first, resolved ones folded; read-only, each links to GitHub where you can reply). It is named for the PR, starts in its repo, uses From prompt with `PR-URL` and `PROJ-XXX` filled in, and opens the PR as its first tab. Everything else works as for any new workspace. |
| **Source control** | An accordion for the workspace in view: its branch (↑ahead ↓behind) with a **branch switcher**, a **vs main** comparison of everything the branch changes, the **CI status** of its pull request (click for GitHub), **stage, unstage and discard** per file or all at once (discard asks twice) with a **commit box** (`⌘⏎`), following Claude into any git worktree it checks out (shown as a worktree chip, with that worktree's own branch and history), what Claude is doing, staged and unstaged changes, and a commit graph like VS Code's. Click a file for its diff against HEAD, or a commit for its files and diffs. It refreshes every 5 seconds and whenever Claude starts or stops working, and files that just changed are highlighted, so you can watch the work as it happens. |
| **Review requests** | Open PRs requesting your review, every open PR in `watchRepos`, and your own open PRs (drafts included) in any repo in `watchRepos` or `repoDirs`. Refreshes every 5 minutes or on ↻. Each carries a badge: **Draft**, **Ready for review** (open, waiting on a review), **Can merge** (approved, checks passing, no conflicts), or why it can't merge. Search by text, or filter by author, repo and status. A green dot means the PR already has a workspace. Clicking one also opens the PR in your workspace's tab group, unless it's already open there. |
| **Resize** | Drag the list's right edge to widen it, and the top edge of **Source control** or **Review requests** to make them taller or shorter (double-click an edge to reset). Sizes are remembered. |
| **Organize** | With five or more workspaces a filter box appears (name, ticket, directory, or words like `waiting` and `working`). Right-click a workspace to **pin** it to the top, **archive** it (tucked under *Archived*, skipped by the switch shortcuts), rename it, or give it a color. |
| **Reorder** | Drag workspaces in the list; the shortcuts follow that order. Workspaces that share a window as tab groups stay in step with the tab strip both ways: reorder the list and the groups move, drag a group in the strip and the list follows. |
| **Attention** | The toolbar icon shows how many workspaces are waiting for input, and the list header says so too. Turn on **Desktop notifications** in Settings to be told when one starts waiting or finishes; clicking the notification switches to it. |
| **Status** | Red dot: `claude` needs input. Green: working. Sourced from [Claude Mission Control](https://github.com/PrecisionWeaver/claude-mission-control). |
| **Activity** | Expand a session in Settings and choose **Show activity** to see what its Claude has recently done, from its transcript: what you asked, what Claude said, each command by its description, and the files it changed. It refreshes while open. |
| **Usage and cost** | Settings shows each session's token count with an estimated dollar cost, and a 14-day chart across every workspace. Dollars are estimates from per-model rates (cache writes 1.25× input, reads 0.1×); correct them with `pricing` in the config, e.g. `{ "opus": { "input": 15, "output": 75 } }` per million tokens. |
| **Getting started** | Until everything is set up, Settings opens with a checklist: the helper starts at login, the extension ID matches, `gh` is signed in, a prompts file and repo folders exist, a switch shortcut is bound, and you have a workspace. Each open step says how to fix it; **Dismiss** hides it. |
| **Warnings** | Settings lists workspaces holding a lot of memory and dev servers left listening for hours without using any CPU, with a **Stop it** for the servers, and the gear turns amber when there is something to look at. Limits are `limits.memoryWarnMb` (default 4096) and `limits.idleServerHours` (default 4) in the config. |
| **Settings** | The ⚙ in the list header opens an admin view: the helper's status with **Restart** and **Stop** (launchd-managed only) and its log; every workspace's session with the tokens its claude session has used, and the processes beneath it, their CPU, memory and listening ports, each with **Stop** / **Force** (only within that workspace's own tree) and a per-session **Restart**; housekeeping (clear uploads and the log, prune stale worktrees, refresh reviews, export the workspace list); the effective config; and checks for the `gh` login and extension ID. Destructive buttons ask twice. |
| **Send to workspace** | Right-click selected text, a link or a page and choose **Send to workspace** to paste it into that workspace's terminal. It is pasted, never submitted, and control characters are stripped. The workspace's terminal must already be open. |
| **Attachments** | Drag files onto the terminal, or paste a screenshot, and they are saved under `~/.chrome-workspaces/uploads/` (cleared after a week) with their path typed in for `claude` to read. Up to 25 MB each. |
| **Sessions** | Closing the panel leaves `claude` running; reopening reattaches with scrollback. `exit` closes the shell; the next open resumes the last conversation. |
| **Rename / remove** | Double-click a name to rename (a tab group takes the new name). Hover and click × twice to end the session; the window stays open. A removed workspace moves to **Recently closed** (the last 50), and clicking it, or choosing it in `⌘K`, brings it back with its tabs and resumes its conversation. |
| **Appearance** | Settings has **Theme** (system, dark or light) and **Density** (comfortable or compact); the terminal's colors follow the theme. The workspace list is keyboard-friendly: Tab into it, then `↑` `↓` (or `j` `k`), `Home`, `End`, `Enter` to open, `F2` to rename. |
| **Collapse** | `‹` shrinks the list to a narrow rail. |

**Limitations**

- Claude in Chrome picks its own window, so a workspace's `claude` may open tabs elsewhere.
- Reloading the extension closes every side panel. The switch shortcuts reopen it, as does a key bound to *Open the workspace panel*.

## Architecture

```
side panel (xterm.js) ──ws://127.0.0.1:4178──▶ helper (Node) ──▶ PTY: login shell → claude
service worker ───────/control───────────────▶ helper ──▶ ~/.chrome-workspaces/workspaces.json
devspace, Mission Control ──HTTP + token─────▶ helper
```

- **Helper** (`helper/`): a local Node process that owns every shell and the workspace list. The panel is only a view.
- **Extension** (`extension/`): the side panel and a service worker that opens, focuses, and re-pairs windows, matching them to workspaces by their tabs after a Chrome restart.
- **Security**: the helper binds to `127.0.0.1`. WebSockets require the extension's `Origin` and a secret token; the HTTP API requires the token as a bearer header and rejects other origins. The extension reads the token through a native-messaging host from `~/.chrome-workspaces/token` (mode `0600`).

## Setup

Requires macOS, Google Chrome, Node 22+, and `gh` signed in for review requests.

```bash
npm install
npm run gen-key                                    # once: pins the extension ID
npm run setup -- --default-cwd ~/path/to/project   # default: ~
npm run build:extension
npm run agent:start                                # runs the helper now and at login
```

`setup` writes `~/.chrome-workspaces/`, Chrome's native-host manifest, and a LaunchAgent.

In Chrome:

1. `chrome://settings/appearance` → side panel position → **Left**.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. The ID must match `~/.chrome-workspaces/config.json`.
3. Optional: `chrome://extensions/shortcuts` → bind *Open the workspace panel*.
4. Click the toolbar icon to open the panel.

If the panel reports *native messaging host not found*, rerun `npm run setup` and fully restart Chrome.

### Configuration

Optional fields in `~/.chrome-workspaces/config.json` (preserved by `setup`). Restart the helper after editing.

| Field | Purpose |
|---|---|
| `promptsFile` | Prompt note. Default `~/.chrome-workspaces/prompts.md`, which `setup` seeds from `prompts.example.md` if you have none. A standalone `PR-URL`, a PR link ending `/pull/XXXX`, and `PROJ-XXX` are filled in from the PR. Each `**Heading**` starts a section; each `- ` bullet is a prompt. |
| `defaultModel` | `claude --model` for workspaces that pick none, e.g. `"opus"`. Unset leaves it to claude. |
| `pricing` | Dollars per million tokens by model family for the cost estimates, e.g. `{ "opus": { "input": 15, "output": 75 } }`. Merged over built-in estimates. |
| `jiraBaseUrl` | Your Jira site, e.g. `"https://acme.atlassian.net"`. With it, a workspace's ticket opens from its right-click menu and `⌘K`, and a review request shows an **Open in Jira** button. Only an `https` address is accepted. |
| `limits` | When Settings warns: `{ "memoryWarnMb": 4096, "idleServerHours": 4 }`. Both are optional. |
| `repoRoots` | Folders whose git repos the **Repo** picker lists. Default `["~/Documents/Websites", "~/Herd"]`. |
| `repoDirs` | Starting directory for PR workspaces by repo, e.g. `{ "acme/web-app": "~/code/web-app" }`. Unlisted repos use the default. These repos also get your own open PRs listed under review requests. |
| `watchRepos` | Repos whose open PRs (yours included) appear under review requests, for repos that don't request reviewers, e.g. `["acme/api"]`. |

### devspace and Mission Control

`devspace PROJ-1234` creates or focuses the ticket's workspace and opens its Jira ticket. Open the panel in that window once. If the helper is unreachable, `devspace` falls back to iTerm + Chrome; `devspace --classic` forces it.

Mission Control's jump button focuses the workspace window for sessions in Chrome Workspaces and uses iTerm otherwise.

## Helper

| Command | |
|---|---|
| `npm run agent:start` | Start and enable at login |
| `npm run agent:restart` | Restart (**ends every open shell**) |
| `npm run agent:stop` | Stop and disable at login |
| `npm run agent:status` | Show status |
| `npm run helper` | Run in the foreground (stop the agent first) |

Logs: `~/.chrome-workspaces/helper.log`.

## Development

```bash
npm test
npm run typecheck
npm run build:extension   # then reload the extension in chrome://extensions
```

`CW_PORT` and `CW_DATA_DIR` run a second helper alongside the real one.

| Path | Contents |
|---|---|
| `shared/` | Protocol types, window and tab-group re-pairing, commit-graph layout |
| `helper/src/` | Workspace store, sessions, launch, git, review requests and PR details, Mission Control status, HTTP API, control channel |
| `extension/src/` | Service worker, side panel, new-workspace, source-control and review views, helper connection, window and tab-group handling |
| `extension/icons/` | SVG icon sources; PNGs are rendered at build |
| `scripts/` | Key generation, setup, extension build |
| `docs/` | Spike results |
