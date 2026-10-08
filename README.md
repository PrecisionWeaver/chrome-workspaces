# Chrome Workspaces

A terminal per Chrome window, in Chrome's side panel.

Each workspace is an ordinary Chrome window — your real Chrome, with your profile, logins, extensions, and DevTools — plus a terminal docked on the left running `claude`. Keep the tabs for that task in the window and switch between workspaces with `⌃⇧←` / `⌃⇧→` instead of juggling terminal windows and desktops.

```
┌───────────────────────────────────────────────────────────────┐
│  Chrome tabs + toolbar                                         │
├──────────┬───────────────────────┬────────────────────────────┤
│ 1 ORC-12 │                       │                            │
│▸2 ORC-13●│  terminal (claude)    │   web page                 │
│ 3 OPS-88 │                       │                            │
│ +        │                       │                            │
└──────────┴───────────────────────┴────────────────────────────┘
```

Design: [`docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md`](docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md)

## Using it

- **Switch:** `⌃⇧←` / `⌃⇧→`, or click a workspace in the list. Every workspace window takes the size of whichever one you last resized or maximized, so switching looks like the content swapping in place.
- **New workspace:** `devspace ORC-1234` (see below), or `+` in the list. A window that isn't a workspace yet offers to become one when you open the panel in it.
- **Review requests:** the section under the list shows open PRs that request your review (from `gh`, refreshed every 5 minutes or with ↻). Click one to pick a prompt. A dot means it already has a workspace; clicking focuses it.
- **From a prompt:** `+` → **From prompt…** lists the prompts in your vault note. Pick one, edit it (`PR-URL` and `ORC-XXX` are filled from the PR when there is one), and **Start**: the new workspace's `claude` begins with that prompt. It runs once; reopening the workspace resumes the conversation.
- **New window or this one:** both create forms have **Use this window**, which puts the new workspace in the current window instead of opening one. If the window already holds a workspace, that workspace keeps running without a window until you pair it again.
- **After reloading the extension**, Chrome closes every side panel and only a click or shortcut can reopen one. `⌃⇧←` / `⌃⇧→` reopen the panel in each window they switch to, and a key bound to *Open the workspace panel* opens it in the current window.
- **Status:** a red dot means that workspace's `claude` needs input; green means it's working (from [Claude Mission Control](https://github.com/PrecisionWeaver/claude-mission-control)).
- **Sessions:** closing the panel leaves `claude` running; reopening it reattaches with the scrollback. Quitting `claude` drops to the shell, and `exit` closes the panel. The next time the panel opens, the workspace resumes its last Claude conversation.
- **Rename:** double-click a workspace's name; Enter saves, Esc cancels. The ticket link is kept, so `devspace` still finds it.
- **Remove:** hover a workspace and click × twice. This ends its terminal session; its Chrome window stays open.
- **Collapse the list** with `‹` to give the terminal more room.

**Known limitation:** Claude in Chrome chooses its own window, so a workspace's `claude` may open its browser tabs in a different window. Its tools have no way to target a window.

## How it works

```
Chrome window ── side panel (xterm.js) ──ws://127.0.0.1:4178──▶ helper (Node) ──▶ PTY: login shell → claude
service worker ──/control────────────────────────────────────▶ helper ──▶ ~/.chrome-workspaces/workspaces.json
devspace, Mission Control ──HTTP + bearer token──────────────▶ helper
```

- **Helper** (`helper/`) — a local Node process that owns every shell and the workspace list. The panel is only a view.
- **Extension** (`extension/`) — the side panel (list + terminal) and a service worker that opens, focuses, and re-pairs windows. After a Chrome restart it re-pairs windows to workspaces by matching their tabs.
- **Security** — the helper listens on `127.0.0.1` only. WebSockets need this extension's `Origin` *and* a secret token; the HTTP API needs the token as a bearer header and refuses any other `Origin`. The extension fetches the token through a Chrome native-messaging host, which reads it from `~/.chrome-workspaces/token` (mode `0600`).

## Setup

Requires macOS, Google Chrome, and Node 22+.

```bash
npm install
npm run gen-key          # once: pins the extension ID via a public key in manifest.json
npm run setup -- --default-cwd ~/path/to/project   # where `+` workspaces start (default: ~)
npm run build:extension
npm run agent:start      # runs the helper now and at every login
```

`setup` writes `~/.chrome-workspaces/`, Chrome's native-host manifest, and `~/Library/LaunchAgents/com.chrome-workspaces.helper.plist`.

Optional fields in `~/.chrome-workspaces/config.json` (`setup` keeps them):

- `promptsFile`: the prompt note (default `~/Documents/Websites/obsidian-vault/Patterns/Most Used Prompts.md`). Each `**Heading**` line starts a section and each `- ` bullet is a prompt.
- `repoDirs`: where PR workspaces start, by repo, e.g. `{ "vorys-econtrol/pec-platform": "~/Herd/pec-platform" }`. Unlisted repos use the default directory.

Review requests need `gh` signed in (`gh auth status`).

Then in Chrome:

1. `chrome://settings/appearance` → side panel position → **Left**.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. The ID shown should match `~/.chrome-workspaces/config.json`.
3. Optional: `chrome://extensions/shortcuts` → give *Open the workspace panel* a key.
4. Click the toolbar icon to open the panel in a window.

If the panel reports *native messaging host not found*, rerun `npm run setup` and fully restart Chrome.

### devspace and Mission Control

With the helper running, `devspace ORC-1234` creates the ticket's workspace (or focuses it if one exists) and Chrome opens its window at the Jira ticket. Open the panel in that window once with the toolbar icon or your shortcut. If the helper isn't reachable, `devspace` uses the old iTerm + Chrome flow; `devspace --classic` forces that.

Mission Control's jump button focuses a workspace's Chrome window for sessions running in Chrome Workspaces, and uses iTerm for everything else.

## Helper commands

| Command | |
|---|---|
| `npm run agent:start` | Start the helper and enable it at login |
| `npm run agent:restart` | Restart after changing helper code (**ends every open shell**) |
| `npm run agent:stop` | Stop it and disable it at login |
| `npm run agent:status` | Show whether it's running |
| `npm run helper` | Run it in the foreground instead (stop the agent first) |

Logs go to `~/.chrome-workspaces/helper.log`.

## Development

```bash
npm test            # vitest
npm run typecheck
```

After changing extension code, run `npm run build:extension` and click reload on the extension in `chrome://extensions`. `CW_PORT` and `CW_DATA_DIR` run a second helper next to the real one for testing.

| Path | What |
|---|---|
| `shared/` | Protocol types and window re-pairing, shared by helper and extension |
| `helper/src/` | Workspace store, sessions, launch command, Mission Control status, HTTP API, control channel |
| `extension/src/` | Service worker, side panel, helper connection, window handling |
| `extension/icons/` | Icon sources (SVG); PNGs are rendered by the build |
| `scripts/` | Key generation, local setup, extension build |
| `docs/` | Design spec, plans, spike results |
