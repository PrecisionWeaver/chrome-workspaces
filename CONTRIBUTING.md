# Contributing

Setup, commands and conventions are in [docs/development.md](docs/development.md); how the pieces fit is in [docs/architecture.md](docs/architecture.md).

The short version:
- Branch from `main` (`feat/...`, `fix/...`, `chore/...`) and open a pull request. Do not commit on `main`.
- Before pushing, run `npm run format`, `npm run check`, `npm run typecheck`, `npm run test:coverage` and `npm run build:extension`. CI runs the same checks and fails if coverage drops below the floor in `vitest.config.ts`.
- Change a message in `shared/protocol.ts` first; both sides then type-check against it.
- Put pure logic in `shared/` or a small module with its own test, and keep `docs/features.md` and `docs/configuration.md` in step with the feature.
- Use placeholder names (`acme/app`, `PROJ-123`) in tests and fixtures.
- Commit subjects become the release notes, so write them to be read; see [docs/releasing.md](docs/releasing.md). Release notes live on the [Releases page](../../releases).

Report security problems as described in [SECURITY.md](SECURITY.md), not in a public issue.
