# Chrome Workspaces — Full Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the spike into the designed product: named workspaces with a list on the left of the panel, window pairing and re-pairing, `claude` sessions that resume after restarts, Mission Control status badges and jump, `devspace` integration, and a helper that starts at login.

**Architecture:** The helper becomes the single source of truth for workspaces (`~/.chrome-workspaces/workspaces.json`). It exposes a token-authenticated HTTP API for local tools and a `/control` WebSocket that pushes workspace state to the extension. Panels and the service worker both hold a control connection; the service worker is the one that acts on `open`/`focus` requests from local tools. Window pairing and URL-based re-pairing are pure functions in `shared/` so both sides and the tests use one implementation.

**Tech Stack:** As the spike, plus Mission Control's existing Hono/`node:test` setup for its changes.

**Spec:** `docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md` · **Spike results:** `docs/spike-results.md`

**Built.** Departures from this plan, all reflected in the spec:

- Added a `remove` control message and a two-click × in the list; without it the list could only grow.
- The service worker drops every stored pairing on the first state after a browser restart (detected via `chrome.storage.session`), because Chrome can reuse window ids for unrelated windows.
- Closed workspace windows reopen with their last tabs, not just the first URL.
- `CW_PORT` overrides the helper port, for running a throwaway helper beside the real one.
- The extension's switching and panel code have no unit tests; the panel was checked by rendering it in headless Chrome with stubbed APIs.

---

## Decisions taken from the spike

- **Claude in Chrome:** its tools take no window or group parameter (`tabs_context_mcp`, `tabs_create_mcp`, `navigate`), and with no existing group it creates a new window. We cannot target a workspace window from our side. Recorded as a known limitation in the spec; no heuristics are built.
- **Shortcuts:** `⌃⇧←/→` (already the manifest default).
- **Exit behaviour:** keep the spike's — exiting the shell closes the panel and reopening starts a fresh session.

## What a workspace session runs

`$SHELL -l -i -c '<claude command>; exec $SHELL -l -i'` in the workspace `cwd`, with `CW_WORKSPACE_ID` and (when present) `DEVSPACE_TICKET` set.

- First session for a workspace: `claude`.
- Later sessions (after `exit`, helper restart, or Mac restart): `claude --resume <id>` when Mission Control has recorded a Claude session for this workspace, otherwise `claude`. `--continue` is not used because several workspaces share one cwd and it would pick whichever conversation in that directory was most recent.
- Quitting `claude` drops to the shell; `exit` closes the panel.

## File structure

| File | Responsibility |
|---|---|
| `shared/protocol.ts` | Add `Workspace`, `WorkspaceStatus`, control-channel message types |
| `shared/pairing.ts` | `matchWindows()` — URL-overlap re-pairing; `workspaceOrder()` |
| `helper/src/workspace-store.ts` | Load/save/create/update/remove workspaces (atomic JSON) |
| `helper/src/launch.ts` | Build the PTY command/env for a workspace |
| `helper/src/mc-status.ts` | Read Mission Control session files → per-workspace status + Claude session id |
| `helper/src/api.ts` | HTTP API for local tools (Bearer token) |
| `helper/src/control.ts` | `/control` WebSocket hub: broadcast state, receive pair/tabs/create |
| `helper/src/server.ts` | Route `/attach`, `/control`, and HTTP API |
| `helper/src/main.ts` | Wiring; no more spike auto-sessions |
| `extension/src/helper-client.ts` | Token fetch + control connection with reconnect |
| `extension/src/windows.ts` | Shared size, focus/open window for a workspace |
| `extension/src/background.ts` | Shortcuts, `open`/`focus` from helper, re-pairing, tab URL tracking |
| `extension/src/panel.ts` + `panel.html/css` | List column, terminal, unpaired-window picker |
| `scripts/setup.ts` | Add `defaultCwd`; write and load the launchd agent |
| Mission Control `hooks/session-state.ts`, `src/shared/types.ts`, `src/server/app.ts` | Record `cw_workspace_id`; jump via the helper |
| Mission Control `bin/devspace` | Create/focus a workspace when the helper is running; `--classic` keeps the old flow |

---

### Task 1: Shared types and pairing

**Files:** Modify `shared/protocol.ts`; create `shared/pairing.ts`; test `helper/test/pairing.test.ts`

Types:

```ts
export interface Workspace {
  id: string;            // ws-<8 hex>, also the PTY session id
  name: string;          // ticket key or user-chosen name
  ticket: string | null;
  cwd: string;
  url: string | null;    // first URL to open, e.g. the Jira ticket
  windowId: number | null;
  lastTabUrls: string[];
  createdAt: string;
}
export type WorkspaceStatus = 'needs_input' | 'working' | 'idle' | null;
export type ControlToClient =
  | { type: 'state'; workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus> }
  | { type: 'open'; id: string }
  | { type: 'focus'; id: string };
export type ControlToHelper =
  | { type: 'pair'; id: string; windowId: number }
  | { type: 'unpair'; windowId: number }
  | { type: 'tabs'; windowId: number; urls: string[] }
  | { type: 'create'; name: string; windowId: number | null };
```

`matchWindows(workspaces, windows: {id, urls}[], threshold = 0.5)`: for each workspace whose `windowId` is not an open window and that has `lastTabUrls`, score every window not already paired by Jaccard similarity of URL sets; take pairs greedily from highest score; skip below threshold. Returns `{ workspaceId, windowId }[]`.

Tests: exact match pairs; partial overlap above threshold pairs; below threshold does not; a window already paired to another workspace is never taken; two workspaces competing for one window → higher score wins; workspaces whose window still exists are left alone.

`workspaceOrder(workspaces)`: by `createdAt` ascending — the order of the list and of `⌃⇧←/→`.

- [x] Write failing tests → run (fail) → implement → run (pass) → commit `feat(shared): workspace types and URL-based window re-pairing`

### Task 2: Workspace store

**Files:** create `helper/src/workspace-store.ts`; test `helper/test/workspace-store.test.ts`

`new WorkspaceStore(file)`: `list()`, `get(id)`, `findByTicket(ticket)`, `create({ name, ticket?, cwd, url? })`, `update(id, patch)`, `remove(id)`, `pairWindow(id, windowId)` (unpairs any other workspace holding that window — exactly one window per workspace and vice versa), `unpairWindow(windowId)`, `setTabs(windowId, urls)`. Every mutation writes `file.tmp` then renames. Loading tolerates a missing file (empty list) and refuses to start on a corrupt one (throws with the path — never silently overwrite user data).

Tests: create assigns `ws-` id and persists across a new store instance; `pairWindow` moves a window from one workspace to another; `setTabs` updates only the paired workspace; `unpairWindow` keeps `lastTabUrls`; corrupt file throws; `findByTicket` is case-insensitive.

- [x] TDD cycle → commit `feat(helper): persistent workspace store`

### Task 3: Launch command

**Files:** create `helper/src/launch.ts`; test `helper/test/launch.test.ts`

`launchSpec(workspace, { shell, resumeId })` → `SessionSpec` as above. `resumeId` must match `^[0-9a-f-]{36}$` or it is ignored (it is interpolated into a shell command). Env: `CW_WORKSPACE_ID`, `DEVSPACE_TICKET` when ticket set.

Tests: no resume → `claude;`; valid resume → `claude --resume <id>;`; malformed resume ignored; env contents; cwd passed through.

- [x] TDD cycle → commit `feat(helper): workspace launch command with safe resume`

### Task 4: Mission Control status

**Files:** create `helper/src/mc-status.ts`; test `helper/test/mc-status.test.ts`

`readMcStatus(dir)` → `Map<workspaceId, { status, claudeSessionId }>` from `*.json` files with `cw_workspace_id`. Per workspace, the most recently `started_at` session wins; `ended`/`stale` map to `null` status but still provide `claudeSessionId` for resume. Unreadable files are skipped. Missing dir → empty map.

`watchMcStatus(dir, onChange)` — `fs.watch` debounced 200 ms; returns a stop function; tolerates the directory not existing.

Tests: picks newest session per workspace; maps statuses; skips files without `cw_workspace_id`; skips corrupt JSON; missing dir.

- [x] TDD cycle → commit `feat(helper): read Mission Control session state per workspace`

### Task 5: HTTP API and control hub

**Files:** create `helper/src/api.ts`, `helper/src/control.ts`; modify `helper/src/server.ts`; test `helper/test/api.test.ts`, `helper/test/control.test.ts`

HTTP (all require `Authorization: Bearer <token>`; requests carrying an `Origin` header other than the extension are rejected — blocks browser CSRF even without the token):

- `GET /workspaces` → `{ workspaces, statuses }`
- `POST /workspaces { name?, ticket?, cwd?, url? }` → if `ticket` matches an existing workspace, focus it and return `{ workspace, created: false }`; else create, broadcast `open`, return `{ workspace, created: true }` (201). `cwd` defaults to `config.defaultCwd`, must be an existing absolute directory.
- `POST /workspaces/:id/focus` → broadcast `focus`; 404 unknown; 409 when no extension is connected.
- `DELETE /workspaces/:id` → kill its session, remove.

Control WebSocket `/control` (same Origin + subprotocol token as `/attach`): on connect send `state`; any store or status change broadcasts `state`; handles `ControlToHelper` messages by calling the store. `/attach?session=<workspace id>` creates the session from the workspace on demand (Task 3) and 404s for unknown ids — the spike's per-window auto-shell is removed.

Tests: 401 without/with wrong bearer; 403 for a foreign Origin; create → 201 and appears in GET; duplicate ticket → 200 `created:false` and a `focus` broadcast; bad cwd → 400; focus with no control client → 409, with one → message received; control client receives `state` on connect and after `pair`; `/attach` for unknown id → 4404.

- [x] TDD cycle → commit `feat(helper): workspace HTTP API and control channel`

### Task 6: Helper wiring

**Files:** modify `helper/src/main.ts`, `helper/src/config.ts`

Load config (`extensionId`, `defaultCwd`), store, token; `onUnknownSession` → workspace lookup + `launchSpec` with resume id from MC status; watch MC dir and broadcast. Remove the `CW_SPIKE_CWD` path.

- [x] Typecheck + full test suite → commit `feat(helper): wire workspaces, sessions and Mission Control status`

### Task 7: Extension — helper client, windows, service worker

**Files:** create `extension/src/helper-client.ts`, `extension/src/windows.ts`; rewrite `extension/src/background.ts`; modify `extension/manifest.json` (add `tabs`, `alarms`)

- `connectControl(onMessage)` → native-messaging token, WebSocket `/control`, reconnect with backoff, 20 s keepalive (keeps the MV3 worker alive while connected); returns `send()`.
- `windows.ts`: `sharedSize` (moved from spike), `focusWorkspaceWindow(ws)`, `openWorkspaceWindow(ws)` (creates the window at the shared size with `ws.url`, then sends `pair`).
- Service worker: on `open` → `openWorkspaceWindow`; on `focus` → focus if paired else open; `⌃⇧←/→` cycles `workspaceOrder()` among paired workspaces; on each `state` and on `chrome.runtime.onStartup`, run `matchWindows` against open windows and send `pair` for matches; tab create/update/remove (debounced 1 s) sends `tabs` for that window; `windows.onRemoved` sends `unpair`; a 1-minute alarm reconnects if the control socket is down.

- [x] Typecheck + build → commit `feat(extension): workspace-aware service worker`

### Task 8: Extension — panel

**Files:** rewrite `extension/src/panel.ts`, `extension/panel.html`, `extension/panel.css`

Layout: list column (180 px, collapsible to a 44 px rail; state in `chrome.storage.local`) | terminal. List items in `workspaceOrder()`: name, status dot (red `needs_input`, green `working`), current workspace highlighted; click → focus/open; `+` → inline name field → `create` with this window's id when the window is unpaired, else `null` (new window).

The panel resolves its workspace from `state` by `windowId`:

- **Paired:** attach the terminal to `/attach?session=<id>`.
- **Unpaired:** the terminal area shows the picker — "Use this window for…" (workspaces, best URL match first, then unpaired ones) and "New workspace here". Choosing sends `pair`/`create`; the panel attaches when the next `state` arrives.

Keeps from the spike: exit closes the panel; disconnect notice in the terminal.

- [x] Typecheck + build → commit `feat(extension): workspace list and unpaired-window picker`

### Task 9: Setup and launchd

**Files:** modify `scripts/setup.ts`, `package.json`

`setup` also writes `defaultCwd` into `config.json` (keeps an existing value; default `~`) and `~/Library/LaunchAgents/com.chrome-workspaces.helper.plist` (RunAtLoad, KeepAlive, logs to `~/.chrome-workspaces/helper.log`, `WorkingDirectory` = repo, Node path pinned). New scripts: `agent:start` (`launchctl bootstrap gui/$UID …`), `agent:stop` (`bootout`), `agent:restart` (`kickstart -k`). Starting the agent is a separate, explicit step because it replaces any manually started helper and ends every open shell.

- [x] Run setup, inspect the plist with `plutil -lint` → commit `feat: launchd agent and default workspace directory`

### Task 10: Mission Control changes (separate repo)

**Files (in `~/Documents/Websites/claude-mission-control`):** `hooks/session-state.ts`, `src/shared/types.ts`, `src/server/app.ts`, `tests/hook.test.ts`, `tests/server.test.ts`

- Hook records `cw_workspace_id: process.env.CW_WORKSPACE_ID || null` alongside `ticket`. The hook runs in every Claude session, so it stays zero-dependency and the change is minimal.
- `SessionState.cw_workspace_id?: string | null`.
- Jump: when `cw_workspace_id` is set, `POST http://127.0.0.1:4178/workspaces/<id>/focus` with the token from `~/.chrome-workspaces/token` (injectable `focusWorkspace` for tests); otherwise the existing iTerm path. Helper errors map to 502.

Tests (node:test, matching the repo): hook writes `cw_workspace_id` from env; jump calls `focusWorkspace` for a workspace session and `runJump` otherwise; helper failure → 502.

- [x] TDD cycle in that repo → commit there `feat: jump to Chrome Workspaces sessions`

### Task 11: devspace

**Files:** Mission Control `bin/devspace`

Before the AppleScript block: unless `--classic` is given, if `~/.chrome-workspaces/token` exists and `GET /workspaces` succeeds, `POST /workspaces { ticket, url, cwd: $PROJECT_DIR }` and exit. Otherwise fall through to the current iTerm + Chrome flow unchanged.

- [x] Run `zsh -n bin/devspace`; exercise the fallback path with the helper stopped on a test port → commit there `feat(devspace): create Chrome Workspaces when the helper is running`

### Task 12: Docs

Update the spec (Claude in Chrome limitation, resume-by-id decision, `--classic`), README (workspaces, list, agent scripts, devspace), and mark this plan's checkboxes.

- [x] Commit `docs: workspaces build`, push.

### Cutover (needs Mike's go-ahead at the time)

Stop the manually started helper, `npm run agent:start`, reload the extension. This ends every open panel shell.
