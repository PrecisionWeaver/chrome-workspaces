# Chrome Workspaces

A terminal for every Chrome window, docked in Chrome's side panel.

Each workspace is a regular Chrome window, with your profile, logins, extensions, and DevTools, paired with a terminal running `claude`. Keep a task's tabs in its window and switch between workspaces with `⌃⇧←` / `⌃⇧→`.

```
┌───────────────────────────────────────────────────────────────┐
│  Chrome tabs + toolbar                                        │
├──────────┬───────────────────────┬────────────────────────────┤
│ 1 PROJ-12 │                       │                            │
│▸2 PROJ-13●│  terminal (claude)    │   web page                 │
│ 3 OPS-88 │                       │                            │
│ +        │                       │                            │
└──────────┴───────────────────────┴────────────────────────────┘
```

Design: [`docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md`](docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md)

## Features

| | |
|---|---|
| **Switch** | `⌃⇧←` / `⌃⇧→` or click a workspace. All workspace windows share the size you last set, so switching swaps content in place. |
| **Reorder** | Drag workspaces in the list; the shortcuts follow that order. |
| **Create** | `+` opens one view: a name, the **Repo** to start in, **Blank** or **From prompt**, and **New window**, or **This window**. A window that already holds a workspace gives the new one a tab group beside it, so several terminals can live in one window; pick one from the list, or by clicking a tab in its group (its badge takes the group's color). Merging windows into tab groups keeps their workspaces. The **Model** picker sets `claude --model`. Or `devspace PROJ-1234`. A window that isn't a workspace offers to become one. |
| **Prompts** | **From prompt** lists prompts from your notes file. `PR-URL` and `PROJ-XXX` are filled in from the PR. The prompt runs once; reopening resumes the conversation. |
| **Review requests** | Open PRs requesting your review, plus every PR in `watchRepos`. Refreshes every 5 minutes or on ↻. Each carries a badge: **Draft**, **Ready for review** (open, waiting on a review), **Can merge** (approved, checks passing, no conflicts), or why it can't merge. Search by text, or filter by author, repo and status with **Authors** / **Repos** / **Status**. A green dot means the PR already has a workspace. |
| **Status** | Red dot: `claude` needs input. Green: working. Sourced from [Claude Mission Control](https://github.com/PrecisionWeaver/claude-mission-control). |
| **Sessions** | Closing the panel leaves `claude` running; reopening reattaches with scrollback. `exit` closes the shell; the next open resumes the last conversation. |
| **Rename / remove** | Double-click a name to rename. Hover and click × twice to end the session; the window stays open. |
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
| `promptsFile` | Prompt note. Default `~/Documents/Websites/obsidian-vault/Patterns/Most Used Prompts.md`. Each `**Heading**` starts a section; each `- ` bullet is a prompt. |
| `defaultModel` | `claude --model` for workspaces that pick none, e.g. `"opus"`. Unset leaves it to claude. |
| `repoRoots` | Folders whose git repos the **Repo** picker lists. Default `["~/Documents/Websites", "~/Herd"]`. |
| `repoDirs` | Starting directory for PR workspaces by repo, e.g. `{ "acme/app": "~/Herd/app" }`. Unlisted repos use the default. |
| `watchRepos` | Repos whose open PRs (except your own) appear under review requests, for repos that don't request reviewers, e.g. `["acme/starbase"]`. |

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
| `shared/` | Protocol types and window re-pairing |
| `helper/src/` | Workspace store, sessions, launch, Mission Control status, HTTP API, control channel |
| `extension/src/` | Service worker, side panel, helper connection, window handling |
| `extension/icons/` | SVG icon sources; PNGs are rendered at build |
| `scripts/` | Key generation, setup, extension build |
| `docs/` | Design spec, plans, spike results |
