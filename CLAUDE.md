# CLAUDE.md — working in the Axtar plugin

This repo is the **Axtar Claude Code plugin**: hooks + a Mentor consult MCP
server that gate agent edits against org rules. Read `README.md` and
`docs/architecture.md` before making changes.

## Build & verify

```bash
npm install
npm run build       # tsc → dist/ (hooks and MCP server run compiled JS)
npm test            # vitest — keep this green
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src test
npm run format:check
```

`dist/` is required at runtime — the hooks call `node ${CLAUDE_PLUGIN_ROOT}/dist/...`.
**`dist/` is committed to the repo** and is exactly what the marketplace ships:
Claude Code installs the plugin by checking out `main` HEAD and runs `npm install`
with lifecycle scripts **disabled**, so `prepare`/`tsc` never runs on install — an
uncommitted `dist/` would simply be absent at runtime (this is what broke installs
through v0.3.5). Always rebuild and commit `dist/` after changing `src/`
(`npm run build`); CI fails if the committed `dist/` drifts from `src/`, and the
release `version` hook rebuilds it into the release commit.

## Releasing

`package.json` is the single source of truth for the version; the `version` npm
hook syncs it into `.claude-plugin/plugin.json` (never hand-edit that). Cut a
release with one command — see **[`RELEASE.md`](RELEASE.md)** for the full
procedure:

```bash
npm run release:patch    # or release:minor / release:major
```

That bumps + commits + tags `axtar--v<version>` + pushes; the pushed tag triggers
`.github/workflows/release.yml` to publish the GitHub Release. Nothing releases on
a normal commit. CI (`ci.yml`) runs build/test/lint/typecheck/format/validate on
every push + PR.

## Non-negotiable invariants

1. **Fail soft on the hook path.** A hook must never throw in a way that blocks
   a developer's edit when the engine is down. Every failure mode allows the
   edit through and exits `0`. Entrypoints wrap `main()` in a `.catch()` that
   exits `0`.
2. **`src/shared/` is host-agnostic.** It must not `import` anything from
   `src/hosts/`. Host behavior reaches the runner through the injected slots
   (`parseInput`, `assemble`, `outputAdapter`) and the `consultLoopAvailable`
   flag. Do not collapse this seam — it is what keeps the core portable.
3. **Named exports only.** Default exports are an eslint error.
4. **`strict` TypeScript**, including `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes`. Omit absent optional fields rather than passing
   `undefined` onto the wire.
5. **The wire contract is pinned.** `contracts/wire/*.schema.json` are validated
   by `test/unit/contract.spec.ts` against the zod schemas in
   `src/shared/wire/schemas.ts`. Change both together.
6. **The consult server's trust model is deliberate.** `session_id` and
   `files[]` are relayed verbatim to the engine — never validated, defaulted, or
   pre-filtered client-side. The gate is the trust anchor.

## Enforcement form

The Claude Code adapter enforces via **exit code 2 + plain-text stderr**, not
the `permissionDecision: "deny"` JSON form (which had enforcement gaps for the
Edit tool, allow-listed tools, and MCP tools as of early 2026). Preserve this
unless those upstream bugs are confirmed fixed. Rationale lives at the top of
`src/hosts/claude-code/adapter.ts`.

## Layout

- `src/hosts/claude-code/` — Claude Code host (entrypoints, assemble, adapter).
- `src/shared/` — host-agnostic core (runner, engine client, rules, edit sim, gate).
- `src/mcp/consult-server.ts` — bundled `consult` / `session_summary` MCP tools.
- `src/cli/projects.ts` — CLI backing `/axtar:*` commands.
- `commands/`, `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/` — plugin wiring
  (auto-discovered by Claude Code).
- `contracts/wire/` — pinned JSON Schemas.

## Related branch

The `other` branch holds the full dual-host archive (Claude Code **and** Codex).
Codex-only code does not belong on `main`.
