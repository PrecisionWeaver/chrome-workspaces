# Releasing

Releases are tags plus a GitHub Release carrying a zip of the built extension. The helper is installed from a clone (`npm install`, `npm run setup`), so it is not packaged.

## Cut a release

```bash
git checkout main && git pull
npm run release -- patch      # or minor / major
```

`scripts/release.ts` requires a clean `main` in sync with origin, runs the format check, typecheck, tests and the build, creates `release/vX.Y.Z`, bumps `version` in `package.json` and `extension/manifest.json` together, makes one commit, and rebuilds so `extension/dist` carries the new version (reload the unpacked extension to see it). Then:

```bash
git checkout main && git merge --ff-only release/vX.Y.Z && git push
git branch -d release/vX.Y.Z
```

Pushing to `main` triggers `.github/workflows/release.yml`. If `package.json`'s version has no tag, it installs, checks (format, types, tests), builds, zips `extension/dist`, and runs `gh release create vX.Y.Z --generate-notes` with the zip attached. A push whose version is already tagged does nothing, so ordinary commits never publish.

## Choosing the bump

- `patch`: fixes and small tweaks.
- `minor`: new features.
- `major`: breaking changes to config, the protocol between extension and helper, or the data files. Before 1.0, a `minor` may carry such a change; call it out in the notes. The extension and helper must be the same version; say so in the notes.

## Notes

- Release notes are auto-generated from commits since the last tag. Write commit subjects that read well, since they become the changelog.
- A test checks that both version files match.
- To redo a bad release, delete the GitHub release and the tag (`git push origin :refs/tags/vX.Y.Z`), fix, bump again.
- The in-app updater fast-forwards to the newest `vX.Y.Z` tag, so merged work reaches users only once it is released.
