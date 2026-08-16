# Axtar — Claude Code plugin

> **Your agent's model writes. Axtar's models audit.** This plugin gives a coding
> agent two places to spend your team's rule corpus: **before it writes** (check
> the spec) and **when it's done** (check the diff). Every check comes back with
> a receipt — what was considered, what was checked, what was dropped.

The plugin ships **one stdio MCP server** and nothing else. There are no hooks:
nothing intercepts an edit, nothing blocks a tool call. The agent asks for a
check; the platform judges; the answer lands in the transcript.

---

## Install

```
/plugin marketplace add axtar-dev/axtar-plugin
/plugin install axtar@axtar
```

The MCP server runs **compiled** JS from `dist/`, which is **committed to the
repo** — Claude Code installs the plugin by checking out the repository and runs
`npm install` with lifecycle scripts disabled, so it never compiles `src/`
itself. After editing `src/`, run `npm run build` and commit `dist/`; CI fails if
the two drift.

## Configure

Two things: **how to reach the platform** (env vars, per machine) and **which
project's rules govern this repo** (a committed file).

```
/axtar:setup <engine-url> <axtar_pk_…-key>   # write the env vars, verify the connection
/axtar:status                                # which project governs this repo + connectivity
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `AXTAR_ENGINE_URL` | _(required)_ | The platform's `/mentor` base URL, e.g. `https://app.axtar.dev/mentor`. |
| `AXTAR_API_KEY` | _(required)_ | `axtar_pk_…` bearer token from the portal's Settings → API keys. |
| `AXTAR_CHECK_TIMEOUT_MS` | `310000` | Per-request budget. The platform caps a check at 300 s and returns partials rather than exceeding it. |
| `AXTAR_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error`, on stderr. |
| `CLAUDE_PROJECT_DIR` | `process.cwd()` | Repo root; where the search for `.axtar/config.yml` starts. |

Neither of the first two has a fallback: unset, the tools refuse with setup
instructions rather than pointing at localhost and failing as a network error.

**The binding** is a committed `.axtar/config.yml` at the repo root — the only
mechanism, so it travels with the repo and no one has to pick a project locally.
The portal generates it when you create the project:

```yaml
version: 1
project: 3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55 # issued by the portal
```

Only `project:` is read locally. The rest of the file (`knowledge:`) is the
ingest contract and is parsed, strictly, by the platform. Without the file, both
tools refuse and tell you to create the project in the portal — a check against
no rules is worse than no check.

## The two tools

### `axtar_check_spec({ spec | spec_path, ref? })`

The plan, before any code exists. Returns what the spec **must state**, what it
**conflicts** with, what it leaves **unaddressed**, and any open questions.
Advisory, always — a spec check never gates.

```
> check this plan against our rules
  axtar_check_spec(spec_path: "docs/specs/refunds.md")

check_id: 7c1b9e40-2a33-4f61-8d2b-5e9f0a7c3311
url:      https://app.axtar.dev/checks/7c1b9e40-2a33-4f61-8d2b-5e9f0a7c3311
summary:  88 considered · 86 checked · 1 dropped · 1 must-state · 1 conflicts

verdict:  needs_revision (advisory — a spec check never gates)

MUST STATE (1) — paste these lines into the spec:

- The refund amount must never exceed the original charge.
```

Pass exactly one of `spec` / `spec_path`. **For a spec on disk, pass the path** —
the server reads the file, so the agent never spends its context pasting
something it already has.

### `axtar_check_diff({ base_ref?, spec_path?, ref? })`

The finished change. Returns breaches, advisories, and the receipt.

```
> I'm done — check it
  axtar_check_diff()

check_id: 3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55
url:      https://app.axtar.dev/checks/3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55
summary:  212 considered · 209 checked · 3 dropped · 1 breaches · 1 advisories

verdict:  breaches

BREACHES (1)
1. AXT-0001@1 · must · src/api/handler.ts:42 · defended
   evidence: throw new Error("x");
   why:      The refund is issued with no approval check.
   fix:      Gate the refund on an approval.
   source:   stated · docs/refunds.md
```

**The agent passes no diff and no file contents.** The MCP server is the local
*packet producer*: it resolves `base_ref`, runs `git diff` against the **working
tree** — uncommitted and untracked work included, which is the point — reads
every changed file at full content, and uploads once. The working tree is
authoritative and already on disk; an agent hand-copying it wastes its own
context and gets it wrong. The same packet shape is what CI's server-side
producer builds, so both surfaces judge the same thing.

`base_ref` defaults down a ladder, first rung that resolves:

1. the `base_ref` you passed;
2. `merge-base(HEAD, origin/HEAD)` — the remote's default branch;
3. `merge-base(HEAD, origin/main)` — clones where nothing set `origin/HEAD`;
4. `merge-base(HEAD, main)` — repos with no remote at all.

Nothing resolves → the tool asks for an explicit `base_ref` rather than diffing
against the root commit. `ref` (the thread a check belongs to) defaults to the
current branch. Binary files are excluded from the upload, with a note; nothing
else is trimmed locally — the platform owns the packet cap and names the rules it
had to drop.

## The receipt

Every response leads with the same three lines, preformatted by the platform:

```
check_id: chk_7f2a91
url:      https://app.axtar.dev/checks/chk_7f2a91
summary:  212 rules considered · 209 checked · 3 dropped · 2 breaches · 1 advisory
```

Both tool descriptions instruct the agent to surface that block in its summary
and in any PR description it writes, so the proof lands where a human reads it.
`considered` vs `checked` is the honesty property: **what was not judged is as
visible as what was**, and `url` addresses the immutable record behind it.

When the platform cannot answer — timeout, 5xx, an unreachable host — the tools
**fail open**: they return text saying no verdict exists and work may proceed.
They never throw, and they never invent a clean verdict. (CI is the surface that
fails closed.)

## Development

```bash
npm install
npm run build             # tsc → dist/
npm test                  # vitest
npm run typecheck         # tsc --noEmit
npm run lint              # eslint src test
npm run format:check      # prettier
npm run validate:manifests
```

### Conventions

- **Named exports only** — default exports are an eslint error.
- **Never write to stdout** — it is the MCP JSON-RPC channel. Diagnostics go
  through `src/shared/log.ts`, which writes to stderr.
- **The agent surface fails open** — a platform hiccup returns text, never an
  exception that stalls a developer mid-flow. (CI, the other surface, fails
  closed; same core, inverted defaults.)
- **zod is the single source of truth for the wire** — `src/shared/wire/checks.ts`
  mirrors the platform's `api/app/schemas/plugin/check.py`; the fixtures in
  `test/fixtures/wire/` pin the shape.
- **`strict` TypeScript**, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.

See [`CLAUDE.md`](CLAUDE.md) for the working notes and [`RELEASE.md`](RELEASE.md)
for the release procedure.

## License

Proprietary — © Axtar.
