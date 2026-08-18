# CLAUDE.md — working in the Axtar plugin

This repo is the **Axtar Claude Code plugin**: one stdio MCP server exposing
four tools — `axtar_check_spec` (before the code exists), `axtar_check_diff`
(when the change is done), `axtar_check_scan` (existing code, as it stands), and
`axtar_projects` (which project governs this repo, and the config to write to
change that) — against the rules the repo's Axtar project enforces. Read
`README.md` first.

The design authority is the redesign spec in the sibling platform repo:
`docs/superpowers/specs/2026-08-11-axtar-redesign-design.md` — §9 (the calls),
§10 (evidence/receipt), §12 (fail direction), §15 (this repo's role).
The wire contract it implements is `api/app/schemas/plugin/check.py` there.

**The hard reset landed.** The gating hooks, host adapters, the gate CLI and the
Mentor consult server are deleted; what remains is the checks MCP server, the
local packet producer, the wire schemas, the packaging bones — and **one advisory
hook**, `src/hooks/check-reminder.ts` on the `Stop` event. It is not the old gate
and must never grow into one: it evaluates nothing, calls the platform not at all,
cannot deny a tool call, and says its one sentence at most once per unchecked
working-tree state.

## Build & verify

```bash
npm install
npm run build       # tsc → dist/ (the MCP server runs compiled JS)
npm test            # vitest — keep this green
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src test
npm run format:check
npm run validate:manifests
```

**`dist/` is committed** and is exactly what the marketplace ships: Claude Code
installs the plugin by checking out `main` HEAD and runs `npm install` with
lifecycle scripts **disabled**, so `prepare`/`tsc` never runs on install — an
uncommitted `dist/` would simply be absent at runtime. Always rebuild and commit
`dist/` after changing `src/`; CI fails if the committed `dist/` drifts.

## Non-negotiable invariants

1. **Never write to stdout.** In the MCP server it is the JSON-RPC channel; a
   stray `console.log` corrupts the framing and the host drops the connection.
   Every diagnostic goes through `src/shared/log.ts` → stderr. The one exception
   is the hook entrypoint, whose stdout *is* its decision channel: it writes
   exactly one JSON object (`{"decision":"block","reason":…}`), only when it
   nudges, and nothing else ever.
2. **The agent surface fails open** (spec §12). Timeout, 5xx, unparseable body,
   DNS — every failure comes back as text the agent can read, never an exception
   that stalls a developer mid-flow. The engine client returns a discriminated
   result and never throws. (CI is the surface that fails closed.)
3. **The MCP server builds the packet, the agent does not** (spec §15). The
   agent passes no diff and no file contents: `axtar_check_diff` resolves
   `base_ref`, runs `git diff`, and reads the changed files from the working
   tree itself. Any change here must keep the local producer byte-symmetric with
   the platform's CI producer.
4. **zod is the single source of truth for the wire.** The old pinned
   `contracts/wire/*.schema.json` are gone; request and response schemas live in
   TypeScript and mirror `api/app/schemas/plugin/check.py`. The platform forbids
   unknown request fields, so a skew fails loudly rather than arriving as an
   unchecked file.
5. **`.axtar/config.yml` is the only binding.** The plugin reads `project:` from
   it and writes nothing. No local selection state, no chooser; unbound, the
   check tools refuse with setup instructions rather than checking against
   nothing. The rest of the file is the platform's to validate.
   `axtar_projects` and `/axtar:projects` are the *authoring* path, not a
   selector: the tool lists what exists and hands back the exact file to write,
   and the command has the agent edit and commit it. Nothing in `src/` may ever
   write that file, and the platform stores no per-repo choice to write to.
   **Nothing in `src/` writes into the bound repo at all** — not the config, not
   state, not a marker file. The turn-end reminder's memory lives in
   `~/.axtar/state/<sha256 of the repo root path>.json`
   (`src/shared/tree-state.ts`), and a developer's `git status` must never grow a
   line because Axtar is installed.
6. **The reminder is advisory and can never nag.** The `Stop` hook allows the
   stop on every path but one, and the one that nudges records that it did, so a
   second turn over the same tree state is silent. `stop_hook_active`,
   `AXTAR_NO_REMINDER`, an unbound repo, a clean tree, an unreadable tree, a bad
   payload: all allow. Adding a rung that can fire twice for one state, or one
   that calls the platform, is the old gate coming back.
7. **Named exports only.** Default exports are an eslint error.
8. **`strict` TypeScript**, including `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes`. Omit absent optional fields rather than passing
   `undefined` onto the wire.

## Layout

- `src/mcp/checks-server.ts` — the MCP server (the only runtime surface): the
  four tools, their argument schemas, the refusals and the fail-open paths.
- `src/hooks/check-reminder.ts` — the one hook (`Stop`, compiled to
  `dist/hooks/check-reminder.js`): the allow ladder, the single nudge, and the
  `{"decision":"block"}` line it prints. Reads stdin, writes nothing but state.
- `src/shared/tree-state.ts` — the shared work-tree fingerprint (`git status`
  + `git diff HEAD`, hashed) and the `~/.axtar/state/*.json` file behind it. The
  hook and the server must never compute that hash differently, which is why
  there is exactly one of them.
- `src/shared/producer.ts` — the local packet producers: the diff packet
  (base-ref ladder, `git diff`, changed + untracked files read whole) and the
  scan packet (`git ls-files` glob expansion, tracked + untracked-not-ignored).
  All git through `execFile`.
- `src/shared/wire/checks.ts` — zod mirrors of the platform's
  `api/app/schemas/plugin/check.py` and `project.py`; parsing is tolerant and
  never throws.
- `src/shared/render.ts` — what the agent reads: the §10 receipt block first,
  then findings; drift, refusals and fail-open text live here too.
- `src/shared/engine/` — connection config (`AXTAR_ENGINE_URL`, `AXTAR_API_KEY`)
  + the typed JSON client (POST for the checks, GET for `/projects`).
- `src/shared/project/config.ts` — finds `.axtar/config.yml`, reads `project:`.
- `src/shared/log.ts` — stderr logger.
- `test/fixtures/wire/` — pinned response bodies; they track the platform's
  `check.py` and must be updated in the same change it is.
- `commands/`, `.mcp.json`, `hooks/hooks.json`, `.claude-plugin/` — plugin wiring
  (auto-discovered by Claude Code). `hooks/hooks.json` declares the one `Stop`
  entry and points at `${CLAUDE_PLUGIN_ROOT}/dist/hooks/check-reminder.js`.
- `scripts/` — version sync + manifest validation for releases.

## Releasing

`package.json` is the single source of truth for the version; the `version` npm
hook syncs it into `.claude-plugin/plugin.json` (never hand-edit that). See
**[`RELEASE.md`](RELEASE.md)**:

```bash
npm run release:patch    # or release:minor / release:major
```

That bumps + commits + tags `axtar--v<version>` + pushes; the pushed tag triggers
`.github/workflows/release.yml`. Nothing releases on a normal commit. CI
(`ci.yml`) runs build/test/lint/typecheck/format/validate on every push + PR.
