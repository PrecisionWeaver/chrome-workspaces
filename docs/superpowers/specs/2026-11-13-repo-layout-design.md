# Repo layout: feature folders, colocated tests, and the big-four splits

Date: 2026-11-13. Branch: `chore/repo-layout`. One pull request.

## Why

The code lives in three flat roots (`shared/`, `helper/src/`, `extension/src/`) with 26, 38 and 45 files each, so structure is read from file-name prefixes (`settings-*`, `terminal-*`) rather than folders. Tests follow three conventions at once: `scripts/` colocates them, `helper/` and `extension/` mirror them into a sibling `test/` folder, and `shared/` has no home for tests at all, so its twenty tests sit in `helper/test/` along with the test for the extension's `prefs.ts` and the hooks script. Four files are over 500 lines (`git-view.ts` 690, `panel.ts` 548, `admin.ts` 523, `control.ts` 522), and sixteen modules have no test of their own.

The principle applied is "package by feature, not by layer": a folder's name says what the code is for, not what kind of file it is. Tests are colocated so a module and its test move, rename and delete together.

## Decisions already made

- Tests are colocated: `foo.ts` and `foo.test.ts` in the same folder. Shared test helpers live in a `testing/` folder per root, never beside source.
- Scope is moves, plus splitting the four files above, plus a test for every module that lacks one. It lands as one pull request whose commits are ordered so file history survives per commit.
- Layout is feature folders inside each existing root. The roots stay because each is a real runtime boundary: Node (`helper`), Chrome (`extension`), both (`shared`), node with type stripping (`hooks`).
- No `index.ts` barrels. Imports name the file.
- Entry points do not move: `helper/src/main.ts`, `helper/src/native-host.ts`, `extension/src/background.ts`, `extension/src/panel.ts`, `extension/src/popout.ts`. The LaunchAgent plist and the native-messaging manifest hold absolute paths to the first two, so keeping them avoids an install migration. The esbuild entry list and npm scripts also stay unchanged.
- `hooks/`, `scripts/` and `extension/styles/` are unchanged apart from import lines.

## Target layout

```
shared/
  protocol/     protocol, errors, session-file
  sessions/     activity, timeline
  usage/        usage, plan-usage, pricing, resources, guardrails
  workspaces/   attention, list-filter, tab-order, tab-urls, pairing, popout,
                claude-groups, branch-name, templates, prompts, onboarding
  lib/          markdown, fuzzy, keynav, jira, git-graph

helper/src/
  main.ts  native-host.ts                          (entry points)
  transport/    server, api, auth, uploads
  control/      hub, workspace-handlers, git-handlers, messages
  pty/          session, launch, launch-dir, scrollback, paste
  claude/       session-status, activity, tokens, timeline, usage-ledger,
                plan-usage, hooks-config, tail
  git/          git, pr-details, pr-workspace, reviews, repos
  admin/        admin, ledger-sync, snapshot, actions, usage-stats, shell
  store/        workspace-store, history, resource-history, prompts, templates-file
  platform/     config, log, log-rotation, system, updates, start-helper, token
helper/testing/ harness, wait-for

extension/src/
  background.ts  panel.ts  popout.ts               (entry points)
  background/      claude-groups, selection, windows, tabs
  panel/           state, messages, attach, picker, notices, palette-items
  workspace-list/  workspace-list, list-resizer
  source-control/  git-view, git-status, git-changes, git-commits, git-diff,
                   pr-view, launcher
  settings/        settings-view, settings-layout, settings-parts, settings-helper,
                   settings-sessions, settings-resources, settings-usage
  activity/        activity-section, activity-chart
  terminal/        terminal-session, terminal-search, terminal-theme, tool-view, zoom
  create/          create-view, file-drop
  popout/          popout-window
  app/             helper-client, prefs, appearance
  ui/              dom, format, markdown-view, menu, sections, sparkline, palette
extension/testing/ chrome-mock, fixtures
```

Every `.ts` file above has a `.test.ts` beside it once the work is done, except the five entry points (`main.ts` and `native-host.ts` stay excluded from coverage as wiring; the three extension entry points keep their existing tests, which move beside them).

### Placement calls

- `shared/lib/` is the one folder named by kind. It holds modules with no domain of their own. New code goes there only when it fits nowhere else.
- `helper-client` is in `extension/src/app/`, not `panel/`, because the pop-out and the service worker use it too.
- `session-file` and `errors` sit with `protocol` because they are shapes shared with the hooks, not logic.
- `guardrails` and `resources` are `usage`, not `workspaces`, because they describe what a workspace consumes.
- `token` (the helper's auth secret on disk) is `platform`, not `transport`.
- `control-messages.ts` becomes `control/messages.ts`.
- The existing `helper/test/prefs.test.ts` moves to `extension/src/app/prefs.test.ts`; `helper/test/hook.test.ts` moves to `hooks/session-state.test.ts`.
- `helper/test/resources.test.ts` imports the extension's fixtures today; after the move it imports from `extension/testing/fixtures.ts` or takes a copy of the one fixture it needs, whichever is smaller.

## The splits

Each big file becomes a folder-mate set: one file keeps the public factory or class, the rest take one concern each, and a plain context object replaces the closure or private state they shared. Target: no file over roughly 300 lines. Each new file gets its own test; where the parent test already covers a case, the case moves rather than duplicates. The parent tests (`panel.test.ts`, `control/hub.test.ts`, `admin/admin.test.ts`, `source-control/git-view.test.ts`) remain as the integration tests of each factory.

### `extension/src/panel.ts` (548) → `panel.ts` + `panel/`

Today: module-level `let` state closed over by views built in the same file. After: the entry file keeps the element lookups, builds the views and wires them (about 150 lines).

| File                     | Takes                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel/state.ts`         | `PanelState`: workspaces, statuses, waiting, reviews, history, jiraBase, selection; `current()`. Views read from it instead of file-level variables. |
| `panel/messages.ts`      | The control-message dispatcher now inline in `connectControl`, as a function over the views and the state.                                           |
| `panel/attach.ts`        | attach, detach, sendToSession, fitTerminal, the session link.                                                                                        |
| `panel/picker.ts`        | renderPicker (the window picker).                                                                                                                    |
| `panel/notices.ts`       | showNotice, showInstallNotice, showOfflineNotice, `INSTALL_COMMAND`.                                                                                 |
| `panel/palette-items.ts` | paletteItems.                                                                                                                                        |

### `helper/src/control.ts` (522) → `control/`

The class stays; the 200-line `handle` switch and the 90-line `handleGit` leave it. `ControlHub` implements a small `HubContext` interface (options, send, sendTo, broadcastState, remove) that the handler modules take, so handlers are functions, not more private methods.

| File                            | Takes                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control/hub.ts`                | `ControlHub`: clients, following, add, remove, send, sendTo, broadcastState, state, pushActivity, and the short cases (pair, unpair, tabs, system, admin, timeline, activity). `handle` routes to the handler modules. |
| `control/workspace-handlers.ts` | create, rename, move, mark, order, restore, forget.                                                                                                                                                                    |
| `control/git-handlers.ts`       | handleGit, gitDirectory, the `GitRequest` type.                                                                                                                                                                        |
| `control/messages.ts`           | control-messages.ts as is.                                                                                                                                                                                             |

### `helper/src/admin.ts` (523) → `admin/`

| File                   | Takes                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/admin.ts`       | `createAdmin`, `AdminService`, `AdminOptions`, `ActionResult`; wiring only.                                                                                                                              |
| `admin/ledger-sync.ts` | liveTranscripts, recordLive, earlierEnded, refreshLive, settle: the "count a live transcript once, then read the ledger" bookkeeping, over a context of `TranscriptTokens`, `UsageLedger` and the store. |
| `admin/snapshot.ts`    | `snapshot` as a function over that context plus the options.                                                                                                                                             |
| `admin/actions.ts`     | `run`, pruneWorktrees, killProcess, checkUpdates.                                                                                                                                                        |
| `admin/usage-stats.ts` | `DayTotals`, emptyDay, usageTrend, usageByHour, mergeWorkspaces. Pure; their tests move out of admin.test.ts.                                                                                            |
| `admin/shell.ts`       | defaultRunShell, defaultSpawnDetached, defaultIsManaged, launchctl.                                                                                                                                      |

### `extension/src/git-view.ts` (690) → `source-control/`

One closure with about twenty state variables and eight render functions becomes a `GitViewContext` (element refs, state, `send`, `render`, `showNotice`) and one renderer per pane. Renderers take the context, mutate the DOM, and write state through it.

| File                            | Takes                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `source-control/git-view.ts`    | `createGitView`, the context, refresh and polling, notices, the top-level `render`, open/close.             |
| `source-control/git-status.ts`  | renderStatus: branch, PR, checks, push and pull.                                                            |
| `source-control/git-changes.ts` | renderChanges, renderSave, commit.                                                                          |
| `source-control/git-commits.ts` | renderCommits, showBranches, openBranchMenu.                                                                |
| `source-control/git-diff.ts`    | showDiffView, openWorking, openCommit, openCompare, selectCommitFile, renderDiff, showRefCard, hideRefCard. |

### Left whole on purpose

`shared/protocol/protocol.ts` (650) is types and constants and is documented as the single source of truth; splitting it scatters message shapes for no reader benefit. `create-view.ts` (521), `settings-view.ts` (421) and `workspace-list.ts` (413) already have neighbours carved out and are out of scope.

## Missing tests

Each in the style of its neighbours: `// @vitest-environment happy-dom` with `loadPanelHtml()` for views, the temp-repo harness for helper services, plain unit tests for pure modules.

- Helper: `claude/tail` (tailLines), `control/messages` (isControlToHelper, isAdminAction; today only exercised indirectly).
- Extension: `workspace-list/workspace-list`, `activity/activity-chart`, `ui/sparkline`, `workspace-list/list-resizer`, `app/appearance`, `terminal/terminal-session`, `terminal/terminal-search`, `terminal/terminal-theme`, `settings/settings-helper`, `settings/settings-parts`, `settings/settings-resources`, `settings/settings-sessions`, `settings/settings-usage`.
- Shared: `protocol/session-file` (notificationWaits); `protocol/protocol` gets a small test for workspaceShellSession and any other exported value with behaviour, none for types.
- Every file the splits create.

Coverage thresholds in `vitest.config.ts` stay as they are during the work and are raised once at the end to just under the new figures, as the comment there asks.

## Tooling

- `vitest.config.ts`: `include: ['**/*.test.ts']` with `node_modules` and `extension/dist` excluded; coverage `exclude` gains `**/*.test.ts` and `**/testing/**` beside the two entry points.
- `tsconfig.json`: `include` adds `extension/testing`, drops `extension/test` (`helper` and `shared` already cover their subfolders).
- `biome.json`: the test override's `includes` becomes `["**/*.test.ts", "**/testing/**"]`; the `shared/markdown.ts` override becomes `shared/lib/markdown.ts`.
- `helper/src/claude/hooks-config.ts`: `HOOK_SCRIPT` and `STATUS_LINE_SCRIPT` resolve one level deeper (`'..', '..', '..', 'hooks'`).
- `extension/testing/fixtures.ts` resolves `../panel.html` from the same depth as before, so it is unchanged. `helper/src/native-host.test.ts` resolves `./native-host.ts`.
- `scripts/`, `hooks/` and the hook and native-host tests change import lines only.
- `.github/workflows/*.yml`, `package.json` scripts, `scripts/build-extension.ts`, the plist and the native-host manifest: unchanged.

## Docs

- `docs/architecture.md`: the Layout table is rewritten with one row per folder (grouped under its root), replacing the one-paragraph-per-root rows. The prose elsewhere that names a path (`hooks/session-state.ts`, `shared/pricing.ts`, `helper/src/start-helper.ts`, `shared/popout.ts`, `shared/protocol.ts`) is updated to the new paths.
- `docs/development.md` Conventions: tests sit beside their module; shared helpers go in `testing/`; no barrels; new shared code goes in the bucket it belongs to, `lib/` last; `extension/test/` references become `extension/testing/`.
- `CONTRIBUTING.md`, `CLAUDE.md`, `docs/releasing.md` (if it names a path): protocol path and any other path.
- `docs/features.md` and `docs/configuration.md`: untouched; no behaviour changes.

## Commit order

1. Moves and import rewrites only, plus the tooling changes. Tests pass, coverage unchanged, git shows pure renames.
2. One commit per split, four in all, each leaving tests green.
3. New tests, grouped by folder.
4. Docs and the threshold bump.

## Verification

Every commit passes `npm run format`, `npm run check`, `npm run typecheck`, `npm run test:coverage` and `npm run build:extension` (the CI job). Before the PR: `git diff --stat -M main` shows the first commit as renames; a smoke run in Chrome with the helper restarted (`npm run agent:restart`) and the extension reloaded: open a workspace, the git pane, Settings, a pop-out, and the monitor. The LaunchAgent and native host must keep working without re-running `npm run setup`.

## Risks

- Three unmerged branches (`remove-trend-line-setting`, `usage-chart-hover-focus`, `origin/settings-layout-polish`) will conflict with the move and need rebasing; merging them first is cleaner.
- The `panel.ts` state object changes how views receive `current()` and friends; `panel.test.ts` guards the behaviour.
- Splitting `ControlHub` turns private methods into functions over a context; `control.test.ts` (becoming `control/hub.test.ts`) guards the message handling end to end.
