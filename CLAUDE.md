# Chrome Workspaces

A Chrome side-panel extension and a local Node helper that pair each Chrome window or tab group with a `claude` terminal. macOS only.

Read before changing things:
- [docs/architecture.md](docs/architecture.md): how the pieces fit, and the non-obvious behaviour.
- [docs/development.md](docs/development.md): commands, workflow, conventions.
- [docs/releasing.md](docs/releasing.md): cutting a release.

Essentials: work on a branch, never commit on `main`; run `npm run typecheck`, `npm test` and `npm run build:extension` before committing; message shapes live in `shared/protocol.ts`; keep README feature and config docs in sync; use placeholder names (`acme/app`, `PROJ-123`) in tests.
