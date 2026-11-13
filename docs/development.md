# Development

## Commands

```bash
npm test                  # vitest, ~1000 tests: real git repos and pty sessions, and a fake chrome.* with happy-dom for the extension
npm run test:coverage     # the same, with a coverage floor (vitest.config.ts); CI runs this
npm run typecheck         # tsc --noEmit, covers shared, helper, extension, scripts
npm run format            # Biome formatter
npm run check             # Biome format and lint (CI); `npm run lint` for lint alone
npm run doctor            # checks the local install end to end
npm run build:extension   # esbuild into extension/dist; reload the extension at chrome://extensions
npm run helper            # run in the foreground (stop the agent first)
npm run agent:restart     # restart the launchd helper; ends every open terminal
```

Run `format`, `check`, `typecheck`, `test:coverage` and `build:extension` before committing. Extension-only changes need a reload in Chrome and no helper restart; helper changes need `agent:restart`.

## Workflow

- Work on a feature branch (`feat/...`, `fix/...`, `chore/...`), open a pull request, and merge it on GitHub once CI passes. Do not commit on `main`, and do not push to it: it takes changes only through a merged pull request, release commits included ([releasing.md](releasing.md)).
- Commit when asked; push and merge when asked. Delete merged branches once the user agrees.
- `.github/workflows/ci.yml` runs the Biome check, typecheck, tests with coverage and the build on every pull request and every branch push except `main`; `release.yml` runs the same checks on `main`.
- To release, see [releasing.md](releasing.md).

## Conventions

- Add or change a message in `shared/protocol/protocol.ts` first; both sides then type-check against it. Validate incoming control messages in `helper/src/control/messages.ts` (`isControlToHelper`, `isAdminAction`).
- Folders group code by purpose (the table in [architecture.md](architecture.md)). A new module goes in the folder for what it is for; in `shared/`, pick the bucket it belongs to and use `lib/` only for code with no domain of its own. No `index.ts` barrels: import the file.
- Every module has its test beside it, `foo.ts` and `foo.test.ts`. Put pure logic in `shared/` or a small module with its own test, not inside `panel.ts` or `control/hub.ts`. Helpers that tests share go in `helper/testing/` or `extension/testing/`, never beside source.
- Helper tests use real temp git repos and the `helper/testing/harness.ts` / `wait-for.ts` utilities; prefer those to mocks.
- Extension tests call `installChrome()` from `extension/testing/chrome-mock.ts`, an in-memory `chrome.tabs`, `tabGroups`, `windows`, `storage` and the events and smaller APIs the code uses. It keeps real state, so assert on the resulting tabs and groups, not on calls, and fire events with `fake.events.*.emit`. Tests of views start the file with `// @vitest-environment happy-dom`, load the shipped markup with `loadPanelHtml()` (so ids match `panel.html`), and call `isolateDocumentListeners()` because views never remove their `document` listeners. xterm and `app/helper-client` are replaced with `vi.mock`. Fixtures are in `extension/testing/fixtures.ts`, and `git-fixtures.ts` beside it mounts the git pane for its tests. Extend the fake when code uses an API it lacks. It models Chrome's behaviour only as far as a test needed, so a pass is not a substitute for trying it in Chrome.
- UI: reuse the shared styles (`.section-header`, `.icon-btn`, the `select` rule, the top-bar button rule). Colours come from CSS variables so the light theme works. Keep icon sizes and header buttons identical across sections.
- Comments say why, not what. Match the surrounding style.

## Gotchas

- macOS sed is BSD sed; prefer small Python or Node edits for multi-line changes.
- `docs/features.md` and `docs/configuration.md` document every feature and config key; update them with the feature. The README stays high level.
- Most UI can only be verified in Chrome. Say so when it was not looked at.
- Never put real company, ticket or user names in tests or fixtures (`acme/app`, `PROJ-123`, `/Users/me`).
