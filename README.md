# Axtar — Claude Code plugin

> **Axtar is a foundation layer between AI coding agents and your code.** It sits
> in front of every edit an agent makes in Claude Code and gates it against your
> organization's rules — blocking violations *before* they land, surfacing
> advisories *after*, and routing high-altitude decisions through a **Mentor**
> consultation the agent must clear before it can proceed.

The plugin is **hooks-first**: it wires into Claude Code's `PreToolUse` and
`PostToolUse` hooks so it can intercept `Edit`, `Write`, `Bash`, and MCP
filesystem-write tool calls. When an edit trips a blocking rule, the agent
literally cannot land it until the violation is resolved.

---

## How it works

```
                        ┌──────────────────────────────────────────┐
   agent wants to edit  │  Claude Code                             │
   a file ───────────►  │                                          │
                        │   PreToolUse hook  ──►  pre.js           │
                        │        │                   │             │
                        │        │            assemble edit → diff │
                        │        ▼                   ▼             │
                        │   GET /rules         POST /evaluate ─────┼──►  Axtar
                        │        │                   │             │     engine
                        │        │              verdict + gate     │   (platform)
                        │        ▼                   ▼             │
                        │   block (exit 2)   consult required?     │
                        │                          │               │
                        │                    ┌─────┴──────┐        │
                        │       consult MCP  │  /gate     │        │
                        │       tool  ◄──────┤  blocks    │        │
                        │                    └────────────┘        │
                        └──────────────────────────────────────────┘
```

1. **PreToolUse** (`dist/hosts/claude-code/entrypoints/pre.js`) fires before an
   edit lands. It simulates the edit in memory, builds a unified diff, fetches
   the applicable rules for the bound project, and calls the engine's
   `/evaluate` endpoint. A **blocking** verdict exits `2` with a formatted,
   agent-readable explanation — Claude Code refuses the tool call.
2. **Mentor gate** — when `/evaluate` flags a high-altitude edit as
   `consult_required`, the runner calls `/gate`. An uncleared gate blocks the
   edit and tells the agent to call the bundled **`consult`** MCP tool. Only an
   `approve` verdict from `/consult` clears the gate.
3. **PostToolUse** (`.../entrypoints/post.js`) fires after an edit lands and
   surfaces **warning**- and **suggestion**-severity findings plus a
   rule-scoped drift reminder. It cannot un-land an edit, so it always exits `0`
   and its output is informational.

Everything **fails soft**: if the engine is unreachable, the hook logs and
allows the edit through — a governance outage never blocks a developer.

### Components

| Path | Role |
| --- | --- |
| `hooks/hooks.json` | Registers the Pre/Post hooks (auto-discovered by Claude Code). |
| `.mcp.json` | Registers the `axtar-mentor` stdio MCP server (`consult`, `session_summary` tools). |
| `commands/` | Slash commands: `/axtar:setup`, `/axtar:status`, `/axtar:projects`. |
| `src/hosts/claude-code/` | Claude Code host: hook entrypoints, input parsing, verdict rendering. |
| `src/shared/` | Host-agnostic core: engine client, rule cache/filter, edit simulator, gate logic, runner. |
| `src/mcp/consult-server.ts` | The bundled Mentor consult MCP server. |
| `src/cli/projects.ts` | CLI backing the slash commands (bind repo → project, connectivity checks). |
| `contracts/wire/` | JSON Schemas for every request/response on the wire (pinned by tests). |

See [`docs/architecture.md`](docs/architecture.md) for the full design and the
host-agnostic seam.

---

## Install

Axtar is distributed as a Claude Code plugin via this repository's marketplace.

```
/plugin marketplace add axtar-dev/axtar-plugin
/plugin install axtar@axtar
```

Then build the runtime once (the hooks and MCP server run compiled JS):

```bash
npm install
npm run build      # tsc → dist/
```

> The hooks invoke `node ${CLAUDE_PLUGIN_ROOT}/dist/...`, so `dist/` must exist
> after install. Run `npm install && npm run build` in the plugin directory.

## Configure

Point the plugin at your Axtar platform and (optionally) bind the repo to a
project — all from inside Claude Code:

```
/axtar:setup <engine-url> <axtar_pk_…-key>   # write engine URL + API key
/axtar:projects                              # bind this repo to a project
/axtar:status                                # verify connectivity + binding
```

Under the hood these read two environment variables (see
[`docs/configuration.md`](docs/configuration.md) for the full list):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AXTAR_ENGINE_URL` | `http://127.0.0.1:8765` | Base URL of the platform's Mentor API (`/evaluate`, `/rules`, `/gate`, `/consult`, …). |
| `AXTAR_API_KEY` | _(none)_ | `axtar_pk_…` bearer token; required by the hosted platform. |
| `AXTAR_HOOK_TIMEOUT_MS` | `10000` | Per-request budget for the gate/evaluate hook path. |
| `AXTAR_CONSULT_TIMEOUT_MS` | `90000` | Per-request budget for the (quality-first) consult path. |

The project binding is persisted to a committed `.axtar/config.json` so it
travels with the repo.

---

## Development

```bash
npm install
npm run build           # tsc → dist/
npm test                # vitest (unit + contract)
npm run test:integration  # RUN_INTEGRATION=1 vitest (end-to-end)
npm run typecheck       # tsc --noEmit
npm run lint            # eslint src test
npm run format          # prettier --write
```

### Conventions

- **Named exports only** — default exports are an eslint error.
- **Fail-soft on the hook path** — the plugin must never throw in a way that
  blocks a developer's edit when the engine is down.
- **The `src/shared/` layer is host-agnostic** — it must not `import` from
  `src/hosts/`. Host specifics reach it through injected slots (`parseInput`,
  `assemble`, `outputAdapter`). See [`CLAUDE.md`](CLAUDE.md).

---

## Repository layout & branches

- **`main`** (this branch) — the Claude Code plugin, trimmed to exactly what
  Claude Code needs to run.
- **`other`** — the full dual-host archive, including the **Codex** host and its
  build tooling, preserved so nothing is lost. See that branch's README.

## License

Proprietary — © Axtar.
