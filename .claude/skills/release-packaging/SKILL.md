---
name: release-packaging
description: Use this skill when the user wants to cut a new release of the VS Code Debug MCP extension, bump the version, write release notes, tag, or package a .vsix. Walks through a checklist so we don't ship a broken release.
---

# Release packaging for vscode-debug-mcp

Goal: produce a clean GitHub Release (tag + `.vsix` + rendered notes) without missing a step.

The release workflow at [.github/workflows/release.yml](../../../.github/workflows/release.yml) is **tag-triggered** on `v*.*.*`. It will fail loudly if anything is inconsistent — your job is to make all the prerequisites true *before* pushing the tag.

## Pre-flight checklist

Run these in order. Stop and fix at the first failure.

1. **Pick the next version**. Follow semver:
   - Patch (`0.1.0` → `0.1.1`): bug fixes only, no new tools, no schema changes
   - Minor (`0.1.0` → `0.2.0`): new tools, new settings, additive changes
   - Major (`0.1.0` → `1.0.0`): renamed/removed tools, breaking schema changes
2. **Working tree is clean** on `main`:
   ```bash
   git status
   git pull --ff-only
   ```
3. **Tests / build pass locally**:
   ```bash
   npm ci
   npx tsc -p . --noEmit
   npm run compile
   ```
4. **Bump `package.json` version** to the new version (no `v` prefix).
5. **Write release notes** at `releasenotes/<version>.yaml` — see the schema in [releasenotes/README.md](../../../releasenotes/README.md). Required keys: `version`, `date` (today, YYYY-MM-DD), at least one of `highlights`/`added`/`changed`/`fixed`/`removed`. Empty sections use `[]`.
6. **Preview the rendered notes** locally:
   ```bash
   node scripts/render-release-notes.js <version>
   ```
   Read it. Does it make sense to a user who didn't read the diff? If not, rewrite.
7. **Package a local .vsix** to sanity-check before tagging:
   ```bash
   npx vsce package --out /tmp/preview.vsix
   code --install-extension /tmp/preview.vsix --force
   ```
   Reload VS Code, open the sample workspace, confirm the status bar shows `MCP :<port>`, run one tool from an MCP client. If anything is broken, fix and restart from step 1.
8. **Update README** if the tool surface, settings, or install instructions changed. Don't ship a release whose README disagrees with reality.
9. **Update [sample-workspace/](../../../sample-workspace/)** if any tool examples in its README would break.

## Cut the release

Only after all of the above passes:

```bash
# 1. Commit version bump + notes together
git add package.json package-lock.json releasenotes/<version>.yaml README.md
git commit -m "Release v<version>"

# 2. Push main first, then tag
git push origin main

git tag v<version>
git push origin v<version>
```

The release workflow will:
- Verify `package.json` version matches the tag (mismatch = fail)
- Verify `releasenotes/<version>.yaml` exists (missing = fail)
- Build, typecheck, package
- Render notes from YAML
- Create the GitHub Release and attach the `.vsix`

Pre-release versions (tag contains `-`, e.g. `v0.2.0-rc.1`) are automatically marked prerelease.

## After the release lands

1. Check the [Releases page](https://github.com/cgaspard/vscode-debug-mcp/releases). The notes should look correct and the `.vsix` should be attached.
2. Download the `.vsix` and install it cleanly in a fresh VS Code window. Confirm:
   - Extension activates without errors (`Output → Debug MCP`)
   - MCP server reachable at `http://127.0.0.1:6736/mcp`
   - Sample workspace's launch configs and tasks are visible via `list_launch_configurations` / `list_tasks`
3. Announce — link the release page where appropriate.

## Hotfix recipe

If a release ships broken and you need a quick patch:

1. Branch from the tag: `git checkout -b hotfix/<version> v<broken-version>`
2. Apply the minimal fix
3. Bump patch version in `package.json`
4. Create `releasenotes/<new-version>.yaml` with a `fixed:` section calling out exactly what was wrong
5. PR into main (or fast-forward if you're the only committer), then follow the standard cut-the-release steps above

## Don't

- Don't push a tag before the matching `releasenotes/<version>.yaml` exists — the workflow will reject it but you'll have a dangling tag to clean up.
- Don't edit a release file *after* the tag is pushed. If notes are wrong, ship a patch release with a correction in `changed:`. The YAML in `main` is the historical record.
- Don't skip the local install test. CI builds the `.vsix` but only an actual install can catch activation errors, missing `package.json` `main`, or runtime crashes.
- Don't bump version in a separate commit from the release notes. They must land together so `main` is always coherent.
- Don't use `git tag -f` or force-push tags. Always make a new patch version.

## Quick reference

| Step | Command |
| --- | --- |
| Bump version | edit `package.json` |
| Render notes | `node scripts/render-release-notes.js <version>` |
| Package locally | `npx vsce package --out /tmp/preview.vsix` |
| Tag + push | `git tag v<version> && git push origin v<version>` |
| Watch the build | `gh run watch` |
