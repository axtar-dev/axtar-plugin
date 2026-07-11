# Releasing Axtar

Cutting a release is **one command**:

```bash
npm run release:patch      # bug fix     0.3.4 → 0.3.5
npm run release:minor      # new feature 0.3.4 → 0.4.0
npm run release:major      # breaking    0.3.4 → 1.0.0
```

That's it. Everything below is just what that command does and how to recover if
something looks off.

---

## What the one command does

`npm run release:*` runs `npm version` (plus a push), which chains:

1. **`preversion`** → `npm test`. A red suite aborts the release before anything
   changes.
2. **bump** → writes the new version into `package.json` **and**
   `package-lock.json`.
3. **`version`** → `scripts/sync-version.mjs` copies that version into
   `.claude-plugin/plugin.json` and stages it, so the two manifests never drift.
   (`package.json` is the single source of truth; you never edit `plugin.json`
   by hand.)
4. **commit** → `release: v<version>`, including all three files.
5. **tag** → `axtar--v<version>` (the `axtar--v` prefix comes from `.npmrc`; you
   never type it).
6. **push** → `git push --follow-tags` sends the commit and the tag to `origin`.

Pushing the `axtar--v*` tag triggers the **Release** GitHub Actions workflow
(`.github/workflows/release.yml`), which:

- checks the tag matches the manifest version,
- `npm ci`, then asserts the committed `dist/` is in sync with `src/` (a stale
  build must never ship),
- runs the test suite + `validate:manifests`,
- publishes a **GitHub Release** for the tag with auto-generated notes.

Normal commits never create an `axtar--v*` tag, so the release workflow only ever
fires on a deliberate `npm run release:*`.

## Before you run it

- **Be on `main` with a clean working tree.** `npm version` refuses to run if you
  have uncommitted changes — commit or stash first.
- Land whatever you're shipping on `main` first, then release.

## Picking patch / minor / major

Semantic versioning:

| Command | Bump | Use when |
| --- | --- | --- |
| `release:patch` | `0.3.4 → 0.3.5` | bug fixes, docs, internal changes — no behavior change for users |
| `release:minor` | `0.3.4 → 0.4.0` | new, backwards-compatible functionality |
| `release:major` | `0.3.4 → 1.0.0` | breaking changes to how the plugin behaves or is configured |

## How users get the new version

Once the Release workflow finishes:

```
/plugin marketplace update axtar     # refresh the catalog from GitHub
/plugin update axtar@axtar           # pull the new version
```

Then restart Claude Code to apply. The bumped `version` in `plugin.json` on `main`
is what Claude Code compares against to offer the update; the tag + Release are the
formal marker and changelog.

## Manual fallback (no npm)

The same tag can be produced with Claude Code's built-in command, which also checks
that `plugin.json` and the marketplace entry agree:

```bash
# after committing a version bump to both manifests:
claude plugin tag                    # creates axtar--v<version>
git push --follow-tags origin main
```

## Troubleshooting

- **"Git working directory not clean"** — `npm version` won't run with pending
  changes. Commit or stash, then retry.
- **Release workflow failed: "version mismatch"** — `plugin.json` and
  `package.json` disagree. This shouldn't happen via `npm run release:*` (the
  `version` hook syncs them); if you hand-edited, run `node scripts/sync-version.mjs`,
  commit, and re-tag.
- **Release workflow failed: "tag does not match manifest version"** — the pushed
  tag isn't `axtar--v<manifest version>`. Delete the stray tag
  (`git push origin :refs/tags/<tag>`) and release again with `npm run release:*`.
- **Need to re-run a release** — delete the tag locally and on the remote, then
  re-run. `dist/` **is** committed (the marketplace installs `main` HEAD without
  running build scripts, so the checked-in `dist/` is what ships); the `version`
  hook rebuilds and stages it into every release commit, so you never bump it by
  hand.
