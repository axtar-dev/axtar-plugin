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
It is gitignored and rebuilt by the `prepare` script on every `npm install`
(that's how a marketplace install compiles itself). Rebuild after changing
`src/`.

## Releasing

Version lives in **both** `.claude-plugin/plugin.json` and `package.json` and
they must stay equal (CI's `validate:manifests` and `claude plugin tag` enforce
it). Releases are git tags `axtar--v<version>` and are **manual** — never
automatic:

1. Bump `version` in both manifests, run `npm install` (updates the lockfile),
   `npm test`, `npm run validate:manifests`, commit, push.
2. Cut the release: run the **Release** GitHub Actions workflow by hand
   (`gh workflow run release.yml`), or locally `claude plugin tag && git push --tags`.

CI (`ci.yml`) runs build/test/lint/typecheck/format/validate on every push + PR.

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
