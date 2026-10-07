# Spike results

**Date:** 2026-10-07
**Chrome:** 154.0.8037.98, macOS
**Build:** `main` at the foundation + spike plan, plus the fixes listed below

## Shortcuts accepted

- `⌃⌥←` / `⌃⌥→` (the plan's suggestion) did **not** work for switching.
- `⌃⇧←` / `⌃⇧→` works. It is now the manifest's suggested key (`MacCtrl+Shift+Left/Right`), so fresh installs get it without visiting `chrome://extensions/shortcuts`.

## Panel width

Not measured. The terminal has been a usable size in day-to-day testing, so this is not blocking. Measure it when the workspace-list column is added, since that is when the width gets shared.

## Shortcuts with terminal focused

Switching works with the terminal focused. No stray input was reported.

Found during testing: switching resized the target window to the size of the window being left, so one small window shrank the rest. Fixed — the most recent resize or maximize of any workspace window is remembered and applied on switch (`948a53d`).

## Persistence

Closing the panel and reopening it reattaches to the same running shell with its output intact.

Also found during testing, and fixed:

- `claude` started in a panel warned *"Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION"*, because the helper had been started from inside a Claude Code session and passed its environment through. Shells now get `CLAUDECODE` and `CLAUDE_*` stripped (`7770003`).
- Typing `exit` left a dead panel that ignored input. Exiting now closes the panel, and reopening it starts a fresh shell (`1ec1941`). A lost helper connection now prints a visible notice instead of silently swallowing input.

## Claude in Chrome targeting

Not tested in this setup. Mike's past experience is that Claude in Chrome opens its tab group in an arbitrary window, and nothing in this build controls which window it uses, so treat it as a **known issue**: a workspace's `claude` will probably not reliably use that workspace's window.

## Decision

**Continue with design B** (terminal in Chrome's side panel). No result points to the frame-app fallback.

Carry into the next plan:

1. Claude in Chrome window targeting — first find out whether a session can be pointed at a specific window. If not, document the limitation.
2. Panel width — measure once the list column exists.
3. The helper currently runs by hand (or detached via `nohup`); start-at-login via launchd is still to do.
