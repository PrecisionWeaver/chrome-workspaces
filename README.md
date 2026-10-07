# Chrome Workspaces

A terminal per Chrome window, in Chrome's side panel.

Each workspace is an ordinary Chrome window — your real Chrome, with your profile, logins, extensions, and DevTools — plus a terminal docked on the left. Run `claude` (or anything else) in the terminal, keep the tabs for that task in the window, and switch between workspaces without juggling separate terminal windows or desktops.

> **Status: spike.** The foundation works — a live terminal in the side panel, one shell per window, survives the panel closing. The workspace list, window pairing, and start-at-login are not built yet. See the [design](docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md).

## How it works

```
Chrome window ── side panel (xterm.js) ──ws://127.0.0.1:4178──▶ helper (Node) ──▶ PTY: your shell
                       ▲
                       └── token via native messaging (never in a URL or page)
```

- **Helper** (`helper/`) — a local Node process that owns every shell. The panel is only a view, so closing or reloading it never kills what's running; reopening replays the scrollback.
- **Extension** (`extension/`) — an MV3 extension whose side panel renders the terminal for its window.
- **Security** — the helper listens on `127.0.0.1` only and accepts a connection only with this extension's `Origin` *and* a secret token. The extension fetches the token through a Chrome native-messaging host, which reads it from `~/.chrome-workspaces/token` (mode `0600`).

## Requirements

- macOS, Google Chrome
- Node 22+

## Setup

```bash
npm install
npm run gen-key          # once: pins the extension ID via a public key in manifest.json
npm run setup            # writes ~/.chrome-workspaces/ and Chrome's native-host manifest
npm run build:extension
npm run helper           # leave running; CW_SPIKE_CWD=<dir> sets where shells start
```

Then in Chrome:

1. `chrome://settings/appearance` → side panel position → **Left**.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. The ID shown should match `~/.chrome-workspaces/config.json`.
3. Optional: `chrome://extensions/shortcuts` → assign keys to *Open the workspace panel*, *Next workspace*, *Previous workspace*.
4. Click the toolbar icon to open the terminal for that window.

`exit` closes the panel; reopening it starts a fresh shell. If the panel reports *native messaging host not found*, rerun `npm run setup` and fully restart Chrome.

## Development

```bash
npm test            # vitest
npm run typecheck
```

After changing extension code, run `npm run build:extension` and click reload on the extension in `chrome://extensions`. After changing helper code, restart `npm run helper` (this ends every open shell).

| Path | What |
|---|---|
| `shared/protocol.ts` | Message types and constants shared by helper and extension |
| `helper/src/` | Sessions, scrollback, auth, WebSocket server, native-messaging host |
| `extension/src/` | Service worker and side panel |
| `extension/icons/` | Icon sources (SVG); PNGs are rendered by the build |
| `scripts/` | Key generation, local setup, extension build |
| `docs/` | Design spec and implementation plans |
