# Releasing

A release is a `vX.Y.Z` tag on `main`; there are no GitHub Releases and nothing is packaged: the helper and extension are installed from a clone (`npm install`, `npm run install-app`), and GitHub's automatic source archives are not an install path, since they have no `.git` for the in-app updater.

## Cut a release

```bash
git checkout main && git pull
npm run release -- patch      # or minor / major
```

`scripts/release.ts` requires a clean `main` in sync with origin, runs the format check, typecheck, tests with the coverage floor and the build, creates `release/vX.Y.Z`, bumps `version` in `package.json`, `package-lock.json` and `extension/manifest.json` together, makes one commit, and rebuilds so `extension/dist` carries the new version (reload the unpacked extension to see it). Then the release commit goes to `main` like any other change, as a pull request:

```bash
git push -u origin release/vX.Y.Z
gh pr create --base main --title "release: vX.Y.Z" --fill
```

Merge it on GitHub once CI passes (squash, like the rest), then update and tidy up:

```bash
git checkout main && git pull
git branch -D release/vX.Y.Z    # a squash merge leaves the branch looking unmerged, so -d refuses it
```

`main` takes no direct pushes and no local merges, so the old fast-forward (`git merge --ff-only release/vX.Y.Z && git push`) is not available; the pull request is the only way in.

Merging to `main` triggers `.github/workflows/release.yml`. If `package.json`'s version has no tag, it installs, checks (format, types, tests), builds, and pushes the tag `vX.Y.Z`. A push whose version is already tagged does nothing, so ordinary commits never tag.

## Choosing the bump

- `patch`: fixes and small tweaks.
- `minor`: new features.
- `major`: breaking changes to config, the protocol between extension and helper, or the data files. Before 1.0, a `minor` may carry such a change; call it out in the notes. The extension and helper must be the same version; say so in the notes.

## Notes

- There are no release notes; the history is the merged pull requests (`git log vA..vB`). Write PR titles that read well, since they become the squash commit subjects.
- A test checks that both version files match.
- To redo a bad release, delete the tag (`git push origin :refs/tags/vX.Y.Z`), fix, bump again.
- The in-app updater fast-forwards to the newest `vX.Y.Z` tag, so merged work reaches users only once it is released.
