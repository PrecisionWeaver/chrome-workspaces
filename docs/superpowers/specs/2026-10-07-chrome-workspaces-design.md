# Chrome Workspaces — Design

**Date:** 2026-10-07
**Status:** Built (spike: `docs/spike-results.md`; build plan: `docs/superpowers/plans/2026-10-07-workspaces.md`)

## Problem

Mike runs 10–12 concurrent `claude` sessions, one per Jira ticket. Each session gets its own macOS Space holding an iTerm window and a Chrome window (with whatever tabs that ticket needs), and he swipes between Spaces. He wants all of them housed on one desktop and to tab through them, with a terminal and a browser per tab.

## Hard constraints

- **The browser must be Mike's real Chrome** — his profile, logins, extensions, DevTools, and Claude in Chrome. Embedded engines (cmux's WebKit pane, Electron's Chromium) are out.
- **macOS cannot embed another app's window inside a host app.** Any "frame app with Chrome docked in" is window-chasing (lag on drag/resize, no native fullscreen, Chrome separate in ⌘Tab). Rejected for that reason.
- Therefore the terminal moves *into* Chrome rather than Chrome moving into something else. iTerm is given up for this workflow.

## Shape

One **workspace** = one ordinary Chrome window (any number of tabs, used normally) + one shell running `claude`.

Each workspace window shows Chrome's side panel on the **left** (a one-time Chrome setting the user flips; extensions cannot set it). The panel is one extension page laid out in two columns:

```
┌──────────────────────────────────────────────────────────────┐
│  Chrome tab strip + toolbar (unchanged)                       │
├─────────┬──────────────────────┬─────────────────────────────┤
│ORC-1234 │                      │                             │
│▸ORC-1250│  terminal (claude)   │        web page             │
│OPS-88 ● │                      │                             │
│ +       │                      │                             │
└─────────┴──────────────────────┴─────────────────────────────┘
 └── side panel (extension page) ┘
```

- **Left column:** workspace list. Always on the left; no top-strip toggle. Collapsible to a slim icon rail to give the terminal room. Shows a "needs input" badge (●) per workspace from Mission Control state.
- **Middle column:** that workspace's terminal (xterm.js).

All workspace windows share identical bounds, so switching workspaces (raising a different window) reads as the content swapping in place.

## Components

### 1. Chrome extension (MV3)

- **Side panel page:** workspace list + xterm.js terminal. The panel is a *view*; it holds no process state. On load it determines its window ID, looks up the paired workspace, and attaches to that workspace's PTY stream.
- **Service worker:** keeps a `/control` connection to the helper (its 20 s ping also keeps the MV3 worker alive), opens and focuses windows when local tools ask, re-pairs windows by tab URLs, and reports each workspace window's tab URLs to the helper.
  - Switch = `chrome.windows.update(id, { focused: true, ...sharedSize })`, where the shared size is whichever workspace window was last resized or maximized.
- **Commands (shortcuts):** previous / next workspace (`⌃⇧←` / `⌃⇧→`, suggested in the manifest) and open panel. Spike finding: `⌃⌥←/→` did not work. Shortcuts work whenever Chrome is focused, including while the terminal has focus. Plain `⌃←/→` is avoided (macOS Spaces, shell word-jump).

### 2. Local helper (Node, `node-pty` + `ws`)

- Owns every shell. Each workspace's PTY is a login shell that runs `claude` in the workspace cwd, with `CW_WORKSPACE_ID` and `DEVSPACE_TICKET` set (any inherited `CLAUDECODE`/`CLAUDE_*` variables are stripped). Quitting `claude` leaves the shell; `exit` closes the panel. The PTY lives independently of the panel, so panel close/reload/unload never kills `claude`.
- A workspace's later sessions run `claude --resume <id>` with the last Claude session Mission Control recorded for it. `--continue` is not used: workspaces often share one cwd, and it would pick whichever conversation there was most recent.
- Keeps a per-PTY scrollback ring buffer (bounded, ~2 MB raw) replayed on attach — reattach behaves like tmux.
- Persists workspace records to `~/.chrome-workspaces/workspaces.json`:
  `{ id, name, ticket, cwd, url, windowId, lastTabUrls, createdAt }`.
- Runs as a launchd agent (starts at login, restarts on crash).
- Listens on `127.0.0.1` only. **Every connection must present a token and an `Origin` of `chrome-extension://<our id>`**; anything else is rejected. (A localhost socket that spawns shells is reachable by any web page otherwise.) The extension obtains the token through a Chrome native-messaging host — a tiny script that reads `~/.chrome-workspaces/token` — so the token never appears in a URL, page, or log.
- Small HTTP API on the same socket for local tools (`devspace`, Mission Control): `GET /workspaces`, `POST /workspaces` (focuses the existing workspace for a ticket instead of duplicating it), `POST /workspaces/:id/focus`, `DELETE /workspaces/:id`. Requires `Authorization: Bearer <token>` (read from the token file); requests with any `Origin` other than the extension's are refused.
- Reads `~/.claude-mission-control/sessions/*.json`, matches sessions to workspaces by `cw_workspace_id` (which the Mission Control hook records from `CW_WORKSPACE_ID`), and pushes status to every panel.

### 3. `devspace` integration

- `devspace ORC-1234` → `POST /workspaces { ticket, cwd: ~/Herd/pec-platform, url: <Jira URL> }`. Helper spawns the PTY; the service worker opens a new Chrome window at the Jira URL with shared bounds and pairs it. The user presses the open-panel shortcut once (Chrome requires a user gesture for `sidePanel.open`).
- When the helper isn't reachable, `devspace` falls back to the iTerm + Spaces flow; `devspace --classic` forces it.

### 4. Mission Control integration

- Hooks are Claude Code's, not iTerm's, so session status keeps working unchanged.
- The dashboard's jump action calls `POST /workspaces/:id/focus` for sessions that belong to a workspace, falling back to the existing iTerm StealFocus path for sessions that don't.

## Pairing

- **Automatic:** windows created via `devspace` / the panel's `+` are paired at creation.
- **Claim:** opening the panel in an unpaired window shows "Which workspace is this?" (plus "New workspace here"). Claiming a window for a workspace that already has one **replaces** it; the old window becomes unpaired (exactly one window per workspace).
- Unpaired Chrome windows are untouched by switching.
- **Rename:** double-clicking a name in the list edits it in place. Only the label changes; the ticket stays, so `devspace` dedupes against it.
- **Remove:** the list's × (two clicks) deletes the workspace and ends its terminal session; its Chrome window is left open, unpaired.

## Failure and restart behavior

| Event | Behavior |
|---|---|
| Panel closed / reloaded / unloaded | `claude` keeps running; reopening reattaches with scrollback. |
| Chrome restart | Chrome restores windows with new IDs. Service worker re-pairs each window by best match of its tab URLs to `lastTabUrls`. Low-confidence windows show the claim picker (best guess first) when the panel is opened. Panel must be reopened once per window (user gesture). |
| Helper crash | launchd restarts it; PTYs are lost. Same as Mac restart. |
| Mac restart | Workspace records survive; PTYs don't. Opening a workspace's panel starts a new session that resumes its last Claude conversation by id. |
| Helper unreachable | Panel shows "Helper not running" with the command to start it, and the terminal says it's disconnected. Both reconnect on their own when the helper is back. The list comes from the helper, so it is empty until then. |
| Paired window closed by user | Workspace stays (PTY keeps running); list shows it dimmed as windowless; selecting it opens a window with its last tabs (or its first URL) and re-pairs. |

## Risks the spike checked (`docs/spike-results.md`)

1. **Side panel max width.** Not measured; the terminal has been a usable width in practice. The list collapses to a rail if it gets tight.
2. **Claude in Chrome window targeting — known limitation.** Its tools (`tabs_context_mcp`, `tabs_create_mcp`, `navigate`) take no window or group, and with no existing group it opens a new window. A workspace's `claude` can't be pointed at that workspace's window from our side.
3. **Shortcut capture inside xterm.js.** Works: extension commands win over the focused terminal.

The frame-app fallback (native app hosting the list + terminal, real Chrome window-chased into a slot) was not needed.

## Testing

- **Helper:** unit tests for workspace store, scrollback ring buffer, auth (token + Origin rejection cases), Mission Control matching. Integration test: spawn PTY, attach, detach, reattach, verify replay.
- **Extension:** unit tests for re-pairing (URL-set matching, threshold, contested windows). Switching and the panel are not unit-tested; the panel was checked by rendering it in headless Chrome with stubbed APIs.
- **Manual checklist:** create via `devspace`, switch via each shortcut, Chrome restart re-pair, Mac restart → resume, remove a workspace.

## Out of scope

- Top-strip layout toggle.
- One-window-many-tab-groups mode.
- Multiple Chrome windows per workspace.
- Working from apps other than Chrome (no OS-global hotkeys).
