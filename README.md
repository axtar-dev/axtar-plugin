# axtar-plugin — `other` branch (full dual-host archive)

> **You are on the `other` branch.** This branch is the **complete, unmodified
> source** of the Axtar plugin as it lived in the `platform` monorepo — it
> includes **both** the Claude Code host **and** the Codex host, plus the Codex
> build tooling and marketplace manifest.
>
> The shipping product lives on **`main`**, which is trimmed to the Claude Code
> host only. Everything that is *not* required for the Claude Code plugin to
> work — the Codex host, the `.codex-plugin/` manifest, the `codex-build`
> packaging script, the Codex marketplace, and the Codex-specific tests — is
> preserved here so nothing is lost.

## What's here that isn't on `main`

| Path | Why it's Codex-only |
| --- | --- |
| `src/hosts/codex/` | The Codex host adapter, assemble, hook-input, and entrypoints. |
| `.codex-plugin/` | Codex plugin manifest + Codex hook wiring. |
| `.agents/plugins/marketplace.json` | Codex marketplace pointing at `codex-build/axtar`. |
| `scripts/build-codex.mjs` | Assembles the clean `codex-build/axtar/` install tree. |
| `test/unit/codex-*.spec.ts` | Codex adapter / assemble / hook-input tests. |
| `build:codex` / `clean:codex` npm scripts | Codex packaging entry points. |

The `src/shared/` layer is **host-agnostic** and is shared by both hosts —
it lives on both branches unchanged.

## Building both hosts

```bash
npm install
npm run build          # tsc → dist/  (both hosts)
npm test               # full suite (Claude Code + Codex)
npm run build:codex    # assemble codex-build/axtar/ install tree
```

See the `main` branch for the Claude-Code-focused README, architecture docs,
and install instructions.
