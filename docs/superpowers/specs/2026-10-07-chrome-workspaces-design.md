# Chrome Workspaces — Design

**Date:** 2026-10-07
**Status:** Approved in brainstorming, pending spec review

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
│PROJ-1234 │                      │                             │
│▸PROJ-1250│  terminal (claude)   │        web page             │
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
- **Service worker:** owns window ↔ workspace pairing, switching, and the helper connection.
  - Switch = `chrome.windows.update(id, { focused: true, ...sharedBounds })`.
  - Persists per-window tab URL sets (`chrome.storage.local`) for re-pairing after Chrome restarts.
- **Commands (shortcuts):** previous / next workspace (`⌃⌥←` / `⌃⌥→`), jump to 1–9 (`⌃⌥1`–`⌃⌥9`), open panel. Chrome allows only 4 *suggested* keys per extension; the rest are set once at `chrome://extensions/shortcuts`. Shortcuts work whenever Chrome is focused, including while the terminal has focus. Plain `⌃←/→` is avoided (macOS Spaces, shell word-jump).

### 2. Local helper (Node, `node-pty` + `ws`)

- Owns every shell. Each workspace's PTY runs `claude` in the workspace cwd with `DEVSPACE_TICKET` set. The PTY lives independently of the panel, so panel close/reload/unload never kills `claude`.
- Keeps a per-PTY scrollback ring buffer (bounded, ~2 MB raw) replayed on attach — reattach behaves like tmux.
- Persists workspace records to `~/.chrome-workspaces/workspaces.json`:
  `{ id, name, ticket, cwd, chromeWindowId, lastTabUrls, createdAt }`.
- Runs as a launchd agent (starts at login, restarts on crash).
- Listens on `127.0.0.1` only. **Every connection must present a token and an `Origin` of `chrome-extension://<our id>`**; anything else is rejected. (A localhost socket that spawns shells is reachable by any web page otherwise.) The extension obtains the token through a Chrome native-messaging host — a tiny script that reads `~/.chrome-workspaces/token` — so the token never appears in a URL, page, or log.
- Small HTTP API on the same socket for local tools (`devspace`, Mission Control): `POST /workspaces`, `POST /workspaces/:id/focus`, `GET /workspaces`. Same token required (read from the token file).
- Reads `~/.claude-mission-control/sessions/*.json`, matches sessions to workspaces by `DEVSPACE_TICKET`, and pushes "needs input" state to the panel.

### 3. `devspace` integration

- `devspace PROJ-1234` → `POST /workspaces { ticket, cwd: ~/Herd/app, url: <Jira URL> }`. Helper spawns the PTY; the service worker opens a new Chrome window at the Jira URL with shared bounds and pairs it. The user presses the open-panel shortcut once (Chrome requires a user gesture for `sidePanel.open`).
- The current iTerm + Spaces script is kept as `devspace-classic`.

### 4. Mission Control integration

- Hooks are Claude Code's, not iTerm's, so session status keeps working unchanged.
- The dashboard's jump action calls `POST /workspaces/:id/focus` for sessions that belong to a workspace, falling back to the existing iTerm StealFocus path for sessions that don't.

## Pairing

- **Automatic:** windows created via `devspace` / the panel's `+` are paired at creation.
- **Claim:** opening the panel in an unpaired window shows "Which workspace is this?" (plus "New workspace here"). Claiming a window for a workspace that already has one **replaces** it; the old window becomes unpaired (exactly one window per workspace).
- Unpaired Chrome windows are untouched by switching.

## Failure and restart behavior

| Event | Behavior |
|---|---|
| Panel closed / reloaded / unloaded | `claude` keeps running; reopening reattaches with scrollback. |
| Chrome restart | Chrome restores windows with new IDs. Service worker re-pairs each window by best match of its tab URLs to `lastTabUrls`. Low-confidence windows show the claim picker (best guess first) when the panel is opened. Panel must be reopened once per window (user gesture). |
| Helper crash | launchd restarts it; PTYs are lost. Same as Mac restart. |
| Mac restart | Workspace records survive; PTYs don't. Each terminal shows "Session ended" with a button that runs `claude --continue` in the workspace cwd. |
| Helper unreachable | Panel shows a clear "helper not running" state with the command to start it; list and switching still work from extension storage. |
| Paired window closed by user | Workspace stays (PTY keeps running); list shows it as windowless; selecting it opens a fresh window and re-pairs. |

## Open risks — verified by a spike before building the rest

1. **Side panel max width.** Chrome's docs don't state one. If it caps narrow, list + terminal are cramped; mitigation is the collapsible icon rail.
2. **Claude in Chrome window targeting.** A session using Claude in Chrome may put its tab group in a window other than its workspace's. Check behavior; likely fix is telling each session its window ID.
3. **Shortcut capture inside xterm.js.** Confirm extension commands win over the focused terminal in the side panel.

If (1) proves unworkable, fall back to the frame-app design (native app hosting the list + terminal, real Chrome window-chased into a slot).

## Testing

- **Helper:** unit tests for workspace store, scrollback ring buffer, auth (token + Origin rejection cases), Mission Control matching. Integration test: spawn PTY, attach, detach, reattach, verify replay.
- **Extension:** unit tests for re-pairing (URL-set matching, confidence threshold) and switching logic with `chrome.*` stubbed.
- **Manual checklist:** create via `devspace`, switch via each shortcut, Chrome restart re-pair, Mac restart → `claude --continue`, Claude in Chrome in two workspaces.

## Out of scope

- Top-strip layout toggle.
- One-window-many-tab-groups mode.
- Multiple Chrome windows per workspace.
- Working from apps other than Chrome (no OS-global hotkeys).
