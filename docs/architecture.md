# Architecture

A Chrome side-panel extension plus a local Node helper (macOS). Each workspace is a Chrome window, or a tab group inside a window, paired with a `claude` terminal. The helper owns every shell and the workspace list; the panel is only a view.

```
side panel (xterm.js) ──ws://127.0.0.1:4178──▶ helper ──▶ PTY: login shell → claude
service worker / panel ──/control (typed JSON)─▶ helper ──▶ ~/.chrome-workspaces/workspaces.json
local scripts ──HTTP + bearer token─▶ helper
claude (per workspace) ──hooks──▶ hooks/session-state.ts ──▶ ~/.chrome-workspaces/sessions/*.json ──▶ helper
```

## Layout

| Path | Role |
|---|---|
| `shared/` | Pure, tested modules used by both bundles. `protocol.ts` is the single source of truth for every message and data shape (`Workspace`, `ControlToClient`, `ControlToHelper`, `SystemSnapshot`, ...). Logic that needs no DOM or Node goes here (fuzzy match, markdown parser, list filter, tab order, pairing, pricing, guardrails, git graph layout). |
| `helper/src/` | `main.ts` wires everything. `control.ts` is the `ControlHub` (state, create/remove/restore, order, git, PR requests, timeline, admin). `server.ts`/`api.ts`/`auth.ts` are the HTTP and WebSocket surface. `session.ts`/`launch.ts` spawn PTYs. `git.ts` is the git service. `admin.ts` builds the Settings snapshot and runs admin actions. `session-status.ts` reads the hook's session files, and `hooks-config.ts` writes the settings file that installs the hook; `tokens.ts` and `timeline.ts` read Claude's transcripts. `reviews.ts`, `pr-details.ts` use `gh`. |
| `hooks/` | `session-state.ts`, the script claude runs on session events. It imports only `shared/session-file.ts`, so it has no dependencies to install. |
| `extension/src/` | `panel.ts` orchestrates the side panel (list, selection, palette, appearance, message dispatch). Views: `create-view.ts`, `git-view.ts`, `settings-view.ts`, `pr-view.ts`, `launcher.ts` (review list). `background.ts` is the service worker (attention badge, notifications, tab and group tracking, order sync, context menus). `helper-client.ts` is the connection. |
| `extension/panel.html`, `panel.css`, `styles/` | One page. `panel.css` imports one stylesheet per view from `styles/` (`base.css` holds the variables and shared controls), bundled into one at build time. CSS variables for every colour; the light theme is `:root[data-theme='light']`; icons come from an SVG sprite in `panel.html`. |
| `scripts/` | `install.ts` (setup, build and start in one), `setup.ts` (data dir, native host manifest, LaunchAgent), `uninstall.ts`, `doctor.ts`, `install-paths.ts` (what setup writes, shared by all three), `gen-key.ts` (pins the extension ID; the key is committed, so only a fork needs it), `build-extension.ts`, `release.ts`. |

## Things that are not obvious

- **Selection is per window**, stored in `chrome.storage`. Several workspaces can share a window (tab groups); the list is the selector. The list order is the one order shared by shortcuts, tab groups and the palette; an atomic `order` message keeps the list and Chrome's groups from ping-ponging.
- **Status comes from hooks the helper adds itself.** Every workspace's `claude` starts with `--settings ~/.chrome-workspaces/hooks.json`, a file the helper rewrites at each start. It runs `hooks/session-state.ts` (plain TypeScript, run by `node` with type stripping, so Node 22.18+) on each of eight events, and the script writes one file per session to `~/.chrome-workspaces/sessions/`. Nothing is written to `~/.claude`, so the hooks touch only sessions the helper starts: a `claude` typed by hand after `exit` is not tracked, and `disableAllHooks` or a managed policy silences status. On first start the helper imports the session ids Claude Mission Control recorded (from `~/.claude-mission-control/sessions`, read-only, only workspaces' sessions from the last 30 days), so workspaces open before the upgrade still resume. The hook always exits 0, files untouched for 30 days are pruned at startup, and the session files give status, `transcript_path` and a *static* start `cwd`. Transcripts (`.jsonl`) carry per-message `cwd`, `timestamp`, `model`, `usage` and tool_use blocks. They are tail-read, and each message counts once (streaming repeats a message id). The worktree a session is in comes from the newest transcript `cwd`, not the session file. A session counts as a workspace's only if it started in the workspace's directory (or inside it, e.g. a worktree): a `claude` run from its shell in another project inherits the workspace id, and would otherwise be the one resumed and shown. An ended session that never recorded a message is skipped too, so the last real conversation is the one resumed.
- **Shells inherit a scrubbed environment**: `CLAUDECODE` and `CLAUDE_*` are removed, otherwise `claude` thinks it is a child session and turns transcripts off.
- **Launch** is a login shell running `claude` (or the configured `claudeCommand`, falling back to `claude`), then `exec`ing the shell when it quits. The prompt travels through an env var, never the command text. Models, session ids, the command and configured repo names are validated before they reach a shell.
- **Paste and attach** use bracketed paste via `paste.ts`; dropped or pasted files are written to the uploads dir and their paths inserted.
- **Git runs with `GIT_OPTIONAL_LOCKS=0`**, validated paths and refs, and in the worktree Claude is in (`gitDirectory()` in `control.ts`). Worktrees are detected through `--git-common-dir`. Writes (stage, discard, commit, switch branch) are explicit requests.
- **Cost figures are estimates** from assumed per-family rates in `shared/pricing.ts`, overridable under `pricing` in config. Unknown models show as unpriced rather than $0.
- **Replayed scrollback is flagged, and its answers dropped.** Attaching replays saved output into a fresh xterm; terminal queries in it (device attributes, say) would be answered again and typed into the shell as stray `1;2c` text. The helper marks the replay (`replay: true` on `output`) and the panel drops whatever xterm emits while parsing it.
- **The native-messaging host also starts the helper.** Settings cannot, because it talks to the helper and a stopped one is not listening. The host is launched by Chrome on demand, so a `start` request (`helper/src/start-helper.ts`) bootstraps the launchd plist, or kickstarts the agent if it is loaded but not running. The panel's offline notice sends it.
- **The monitor and the plain terminal are sessions that are not workspaces.** The ids `monitor` and `shell` (`MONITOR_SESSION`, `SHELL_SESSION` in `shared/protocol.ts`) are attached like any workspace, and the helper starts `btop` (or `top`) or a login shell for them in `onUnknownSession`. `server.ts` ends the monitor when the last panel detaches; the shell keeps running until it exits. The panel's `tool-view.ts` has one xterm of its own that shows either, so neither touches the workspace selection or list. The shell has no `CW_WORKSPACE_ID`, so no status hooks apply to a `claude` typed in it.
- **Restarting the helper ends every terminal**, including a Claude session running inside one. The restart is a detached `sleep N; launchctl kickstart -k`, so the reply gets out first.

## Data and config

Everything lives in `~/.chrome-workspaces/`: `config.json`, `token` (mode 0600, handed to the extension by a native-messaging host), `workspaces.json`, `history.json`, `uploads/`, `helper.log`. `CW_PORT` and `CW_DATA_DIR` run a second helper next to the real one. Config keys are documented in [configuration.md](configuration.md).

## Security model

The helper binds to `127.0.0.1`. WebSockets require the extension's `Origin` and the token; the HTTP API requires the token as a bearer header and rejects other origins. Markdown from PRs is parsed into DOM nodes, never injected as HTML. What reaches the network is listed in [privacy.md](privacy.md).
