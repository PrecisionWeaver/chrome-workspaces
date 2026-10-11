# Development

## Commands

```bash
npm test                  # vitest, ~300 tests, real git repos and real pty sessions
npm run typecheck         # tsc --noEmit, covers shared, helper, extension, scripts
npm run build:extension   # esbuild into extension/dist; reload the extension at chrome://extensions
npm run helper            # run in the foreground (stop the agent first)
npm run agent:restart     # restart the launchd helper; ends every open terminal
```

Run `typecheck`, `test` and `build:extension` before committing. Extension-only changes need a reload in Chrome and no helper restart; helper changes need `agent:restart`.

## Workflow

- Work on a feature branch (`feat/...`, `fix/...`, `chore/...`), then fast-forward merge into `main`. Do not commit on `main`.
- Commit when asked; push and merge when asked. Delete merged branches once the user agrees.
- `.github/workflows/ci.yml` runs typecheck, tests and the build on every pull request and every branch push except `main`; `release.yml` runs the same checks on `main`.
- To release, see [releasing.md](releasing.md).

## Conventions

- Add or change a message in `shared/protocol.ts` first; both sides then type-check against it. Validate incoming control messages in `control.ts` (`isControlToHelper`, `isAdminAction`).
- Put pure logic in `shared/` or a small helper module with its own test, not inside `panel.ts` or `control.ts`.
- Helper tests use real temp git repos and the `harness.ts` / `wait-for.ts` utilities; prefer those to mocks.
- UI: reuse the shared styles (`.section-header`, `.icon-btn`, the `select` rule, the top-bar button rule). Colours come from CSS variables so the light theme works. Keep icon sizes and header buttons identical across sections.
- Comments say why, not what. Match the surrounding style.

## Gotchas

- macOS sed is BSD sed; prefer small Python or Node edits for multi-line changes.
- `README.md` documents every feature and config key; update it with the feature.
- Most UI can only be verified in Chrome. Say so when it was not looked at.
- Never put real company, ticket or user names in tests or fixtures (`acme/app`, `PROJ-123`, `/Users/me`).
