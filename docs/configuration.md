# Configuration

Axtar needs two things to govern a repo: **how to reach the platform**
(engine URL + API key) and **which project's rules apply** (the binding). Both
are configurable from inside Claude Code via slash commands, or directly via
environment variables and a committed config file.

## Slash commands

| Command | What it does |
| --- | --- |
| `/axtar:setup [<engine-url> <axtar_pk_…-key>]` | Writes the engine URL and API key to a gitignored local settings file. The key is a secret and is never echoed or committed. |
| `/axtar:projects [<project id or name>]` | Binds this repo to one of your org's Axtar projects (its rule pool). Persists to `.axtar/config.json`. Omit the argument to pick interactively. |
| `/axtar:status` | Reports the current project binding and runs a connectivity / auth check against the platform. |

The commands shell out to the CLI at `${CLAUDE_PLUGIN_ROOT}/dist/cli/projects.js`,
which exposes `list`, `select`, `status`, and `doctor` subcommands.

## Environment variables

| Variable | Default | Read by | Purpose |
| --- | --- | --- | --- |
| `AXTAR_ENGINE_URL` | `http://127.0.0.1:8765` | hooks, MCP, CLI | Base URL of the platform's Mentor API. Endpoints are appended (`/evaluate`, `/rules`, `/gate`, `/consult`, `/bypass`, `/policy`, `/projects`, `/sessions/{id}/summary`). Trailing slashes are stripped. |
| `AXTAR_API_KEY` | _(none)_ | hooks, MCP, CLI | Bearer token (`axtar_pk_…`). Sent as `Authorization: Bearer …`. Required by the hosted platform; ignored by a legacy standalone engine. |
| `AXTAR_HOOK_TIMEOUT_MS` | `10000` | hooks | Per-request HTTP timeout for the gate/evaluate path. Bounded further by the outer `hooks.json` `timeout` (2 s Pre / 5 s Post). |
| `AXTAR_CONSULT_TIMEOUT_MS` | `90000` | MCP consult server only | Per-request HTTP timeout for the consult path (mentor LLM ~45 s + adversarial guard ~45 s + headroom). |
| `AXTAR_HOOK_TRACE` | _(off)_ | hooks | Set to `"true"` to emit a diagnostic trace (hook fired / crashed, request timings) to the debug log. |
| `CLAUDE_PROJECT_DIR` | `process.cwd()` | hooks, MCP, CLI | Repo root used to resolve relative file paths and locate `.axtar/config.json`. Set by Claude Code. |

> **Two-tier latency by design.** The gate/evaluate path is fast
> (`AXTAR_HOOK_TIMEOUT_MS`, 10 s) so it never stalls an edit. The consult path is
> quality-first (`AXTAR_CONSULT_TIMEOUT_MS`, 90 s) because a consultation drives
> LLM calls that outlast the hook budget. The two knobs keep the tiers explicit.

## The project binding — `.axtar/config.json`

Binding a repo to a project is what scopes evaluation to that project's rule
pool (the org constitution is always merged server-side). The binding lives in a
committed file so it travels with the repo:

```json
{
  "version": 1,
  "project": { "id": "prj_123", "name": "payments-backend" },
  "updatedAt": "2026-07-11T12:00:00.000Z"
}
```

- An **unbound** repo (no file, or `project: null`) sends no scope and is
  evaluated against all of the org's rules.
- Reads are **fail-soft**: a missing or malformed config means "no project
  selected", never a thrown error on the hot hook path.

## Which hook fires on what

`hooks/hooks.json` matches these tools:

```
Edit | Write | Bash | apply_patch | mcp__.*__(write|edit|create|delete|move).*
```

`Edit` and `Write` are evaluated with content-level rules. `Bash` and MCP write
tools currently match the hook (so they're visible) but log-and-allow —
content-level evaluation for those surfaces is deferred engine-side.
