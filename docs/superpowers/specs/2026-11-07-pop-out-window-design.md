# Pop a workspace's terminal out into its own window

## Goal

Let a workspace's terminal be opened in a separate, standalone Chrome window that stays on that workspace, next to the work.

## Decisions

- **Pinned.** A pop-out shows the workspace it was opened for and never changes. One pop-out per workspace; several can be open at once.
- **The side panel keeps working.** The pop-out is a second view of the same helper session (the helper already allows several attached clients). Both type into one shell.
- **Terminal only.** A slim header (status badge, name) and the xterm. No list, Git, Activity, PR or Settings.
- **Entry point.** An icon button on each workspace row, next to the archive button, with the same hover-to-show behaviour.
- **Archive and forget icons.** The row's `×` is a text glyph, smaller and unlike every other (SVG) icon. It becomes an SVG at the shared `.icon` size; the "archive?" confirm text stays.

## Design

### Shared (`shared/popout.ts`, tested)

- `popoutUrl(base, id)` builds `popout.html?ws=<id>`.
- `popoutWorkspaceId(url)` reads it back, or `null` when the URL is not a pop-out or the id is not a valid session id.
- `findPopout(windows, base, id)` returns the window already showing that workspace, so a second click focuses it instead of opening another.

### Extension

- `extension/popout.html` and `extension/src/popout.ts`: the page. It reads the id from the URL, applies the saved theme, opens one xterm, attaches to `/attach?session=<id>` (same replay handling as the panel: replayed output is flagged and its answers dropped), and listens to `/control` state for the name and status badge.
  - The window title is the workspace name.
  - If the workspace disappears from state (archived or removed), or the session sends `exit`, the window shows "Workspace closed" and closes itself.
  - Shift+Enter sends ESC + CR, as in the panel.
- `extension/src/popout-window.ts`: `openPopout(workspaceId)` calls `findPopout` over `chrome.windows.getAll({ populate: true, windowTypes: ['popup'] })`, focuses a match, else `chrome.windows.create({ type: 'popup', url, width: 900, height: 600 })`.
- `workspace-list.ts`: the pop-out button on live workspace rows; hidden when the list is collapsed.
- `panel.html`: sprite gains `i-x` and `i-external`.
- `scripts/build-extension.ts`: bundles `popout.ts`, copies `popout.html`.
- Terminal size: with two views on one PTY the last resize wins. Both the panel and the pop-out send a resize when their window gains focus, so the PTY follows the view you are using.

### Helper

No change.

## Error handling

Helper unreachable: the same "[could not reach the helper]" / "[disconnected from helper]" notices the tool view writes into the terminal.

## Testing

Vitest for `shared/popout.ts` and for `popout-window.ts` against the fake `chrome.windows`; a happy-dom test for the row buttons; the pop-out page's attach and close behaviour with `helper-client` mocked. The look of the window and the icons can only be checked in Chrome.

## Docs

`docs/features.md` (the feature) and `docs/architecture.md` (the pop-out page and the shared-session size rule).
