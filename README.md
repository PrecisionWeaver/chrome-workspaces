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

## Highlights

- **A terminal per workspace**: closing the panel leaves `claude` running; reopening reattaches, and `exit` resumes the last conversation.
- **Source control built in**: branch, staged and unstaged changes, diffs, commit graph, CI status, and a commit box, following Claude into any git worktree.
- **Pull-request review**: open and requested PRs in a list; one click starts a workspace in the PR's repo with its details alongside.
- **Command palette** (`⌘K`), templates, status dots, desktop notifications, and an admin view with usage cost and process control.

All of it is in [docs/features.md](docs/features.md).

## Quick start

Requires macOS, Google Chrome, Node 22+, and `gh` signed in for review requests.

```bash
npm install
npm run gen-key                                    # once: pins the extension ID
npm run setup -- --default-cwd ~/path/to/project   # default: ~
npm run build:extension
npm run agent:start                                # runs the helper now and at login
```

Then in Chrome, load `extension/dist` as an unpacked extension at `chrome://extensions` and click the toolbar icon. [docs/setup.md](docs/setup.md) has the Chrome steps, troubleshooting, helper commands, and `devspace` and Mission Control.

## Documentation

| Doc | Contents |
|---|---|
| [docs/setup.md](docs/setup.md) | Install, load the extension, run the helper, `devspace` |
| [docs/features.md](docs/features.md) | Everything the panel does, and its limitations |
| [docs/configuration.md](docs/configuration.md) | `config.json` fields |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit, layout, security model |
| [docs/development.md](docs/development.md) | Commands, workflow, conventions |
| [docs/releasing.md](docs/releasing.md) | Cutting a release |
