# Releasing

Process for cutting a new `owthorize` release. Run from the repo root.

## Pre-flight

1. Working tree is clean: `git status` shows nothing.
2. You're on `main` and up to date: `git pull`.
3. All checks pass:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

## Cutting the release

1. **Bump version + tag in one step.** Pick `patch`, `minor`, or `major` per [semver](https://semver.org/spec/v2.0.0.html):

   ```bash
   npm version patch   # 0.4.1 → 0.4.2 (bug fixes only)
   # or
   npm version minor   # 0.4.1 → 0.5.0 (new features, backwards-compatible)
   # or
   npm version major   # 0.4.1 → 1.0.0 (breaking changes)
   ```

   `npm version` updates `package.json`, creates a commit, and tags the commit `vX.Y.Z` automatically.

2. **Update `CHANGELOG.md`.** Move items from `[Unreleased]` into a new `## [X.Y.Z] — YYYY-MM-DD` section. Update the compare links at the bottom. Amend the version-bump commit:

   ```bash
   git add CHANGELOG.md
   git commit --amend --no-edit
   git tag -f vX.Y.Z   # retag amended commit
   ```

3. **Push the commit and the tag.** Both are required — npm install pulls from npm but contributors browse GitHub:

   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

4. **Create the GitHub Release.** Copy the new `[X.Y.Z]` section from `CHANGELOG.md` into the body. The CLI form:

   ```bash
   gh release create vX.Y.Z \
     --title "v0.X.Y — short tagline" \
     --notes-file <(awk '/^## \[X\.Y\.Z\]/{f=1; next} /^## \[/{f=0} f' CHANGELOG.md)
   ```

   Or use `--notes "..."` with the body inlined, or open the GitHub Releases page and paste manually if that's easier.

5. **Publish to npm.** With 2FA on, this prompts for an OTP:

   ```bash
   npm publish
   ```

6. **Verify both ends:**

   ```bash
   npm view owthorize version
   gh release view vX.Y.Z
   ```

## Conventions

- **Tag format**: `vX.Y.Z` (with `v` prefix). Matches GitHub Release URLs and `npm version`'s default.
- **Patch (`0.4.1 → 0.4.2`)**: bug fixes only, no API surface changes.
- **Minor (`0.4.1 → 0.5.0`)**: new features, additive type changes, deprecations. Existing consumers should upgrade with no code changes.
- **Major (`0.4.1 → 1.0.0`)**: breaking changes. Document the migration path in the changelog entry.
- **Pre-1.0 caveat**: while the version stays sub-1.0, minor-version bumps may include breaking changes if the change is small and the migration is one-line. Always document.

## Hotfix flow

For a production-critical bug:

1. Branch from the published tag: `git checkout -b hotfix-X.Y.Z+1 vX.Y.Z`
2. Apply the fix, run all checks.
3. `npm version patch`, update `CHANGELOG.md`, push commit + tag, create release, `npm publish`.
4. Merge the hotfix branch back into `main` (so `main` includes the fix).

## Things that should NEVER happen

- `npm publish --no-git-checks` — bypasses local cleanliness checks. Don't.
- `npm unpublish owthorize@X.Y.Z` more than 72h after publish — npm blocks it. Even within 72h, prefer publishing a fix as `X.Y.Z+1` rather than unpublishing.
- Force-pushing a tag (`git push -f origin vX.Y.Z`) once the release exists on GitHub. Cut a new tag instead.
- Publishing without 2FA. Enable with `npm profile enable-2fa auth-and-writes` if you haven't.
