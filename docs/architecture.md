# Architecture

Axtar's Claude Code plugin is a thin, fail-soft governance layer. Its job is to
turn every agent edit into a request the Axtar engine can rule on, render the
verdict in a way the agent will actually act on, and route high-altitude
decisions through a Mentor consultation.

## The host-agnostic seam

The codebase separates **what all hosts share** from **what is specific to
Claude Code**. This split is load-bearing — it's what let the same core also
back a Codex host (preserved on the `other` branch).

```
src/
├── hosts/claude-code/     ← Claude Code specifics ONLY
│   ├── entrypoints/pre.ts   PreToolUse hook process
│   ├── entrypoints/post.ts  PostToolUse hook process
│   ├── assemble.ts          Claude stdin → engine request (+ edit simulation)
│   ├── hook-input.ts        zod schemas for Claude's hook payloads
│   └── adapter.ts           verdict/gate → exit code + stderr/stdout
├── shared/                ← host-agnostic core (must NOT import from hosts/)
│   ├── runner.ts            orchestrates a hook end-to-end
│   ├── engine/              HTTP client + connection config
│   ├── rules/               rule cache + path/severity pre-filter
│   ├── edit/                in-memory edit/write simulation + unified diff
│   ├── gate-step.ts         pure gate decision (block / bypass / proceed)
│   ├── output/adapter.ts    the OutputAdapter interface hosts implement
│   ├── drift-advisory.ts    Post-edit rule-scoped reminder
│   ├── rung.ts              autonomy-rung framing
│   └── wire/schemas.ts      zod schemas for the engine wire contract
├── mcp/consult-server.ts  ← bundled Mentor consult MCP server
└── cli/projects.ts        ← CLI backing the slash commands
```

The `shared/runner.ts` never imports a host. It consumes host behavior through
three injected slots on `RunOptions`:

- **`parseInput`** — host stdin → shared `HookInput`
- **`assemble`** — parsed input → an engine request (or a `skip`/`invalid`)
- **`outputAdapter`** — a verdict / gate decision → a `HookEmission`
  (`{ exitCode, stdout?, stderr? }`)

A fourth flag, **`consultLoopAvailable`**, tells the runner whether this host
bundles the `consult` MCP tool. Claude Code does (`.mcp.json`), so it sets
`true` and an uncleared Mentor gate becomes a hard block that points the agent
at a tool it can actually call.

## The PreToolUse flow

1. `pre.ts` reads stdin and calls `run()` with the Claude Code slots and the
   `blocking` severity set.
2. The runner loads engine config, fetches the bound project's rules (cached),
   and asks `assembleForPre` to build the request. Assembly **simulates** the
   edit in memory (`shared/edit/apply.ts`) so it has the post-edit file content
   *before* Claude lands it, then produces a unified diff.
3. Rules are pre-filtered by path and severity so only relevant rules reach the
   engine. If none survive, the hook exits `0` without a network call.
4. `POST /evaluate` returns a verdict (`pass` / `warn` / `block`) and a
   `consult_required` flag.
5. If `consult_required`, the runner consults `POST /gate`:
   - **not cleared** → the Claude Code adapter renders a boxed consult message
     carrying the host `session_id`, and the process exits `2` (edit blocked).
   - **gate unreachable** → **fail open**: emit a loud advisory, best-effort
     `POST /bypass` audit, exit `0` (edit allowed).
   - **cleared** → fall through to the verdict.
6. The verdict is rendered by `adapter.ts`: a `block` exits `2` with a boxed,
   sectioned explanation (WHY THIS RULE EXISTS / WHAT WE FOUND / HOW TO FIX).

## The PostToolUse flow

`post.ts` runs the same runner with the `warning` + `suggestion` severities.
The edit has already landed, so `assembleForPost` **observes** the on-disk file
(no simulation). Post always exits `0`; findings, a drift reminder, and an
optional Rung-2 heartbeat ride out on stderr / `additionalContext`.

## The Mentor consult loop

When the gate blocks, the agent is told to call the bundled **`consult`** MCP
tool (`src/mcp/consult-server.ts`, registered as `axtar-mentor` in `.mcp.json`)
with the `session_id` from the block message, the flagged file(s), and its
question / proposed edit / plan. The server relays this **verbatim** to
`POST /consult`. An `approve` verdict clears the gate; `revise` / `block` do
not. A second tool, **`session_summary`**, fetches the read-only session
summary (including the "Judgment calls" section) for resolution write-ups.

The consult server reads a **separate, longer timeout**
(`AXTAR_CONSULT_TIMEOUT_MS`, default 90 s) because a consultation drives one or
two LLM calls and routinely outlasts the 10 s gate/hook budget.

## Enforcement mechanics (why exit codes, not JSON)

The Claude Code adapter uses the **exit-code-2 + plain-text-stderr** enforcement
form rather than the structured `permissionDecision: "deny"` JSON form. As of
early 2026 the JSON form had documented enforcement gaps for exactly the
surfaces Axtar must block (the `Edit` tool, allow-listed tools, MCP tools), so
the plugin bets on the reliably-enforced exit code. The rationale is captured in
detail in `src/hosts/claude-code/adapter.ts`.

## Fail-soft guarantee

Every failure mode on the hook path allows the edit through and exits `0`:
invalid stdin, malformed payload, no applicable rules, `/rules` unreachable,
`/evaluate` unreachable, gate unreachable, even a crash in the entrypoint's
`.catch()`. Governance degrades to advisory; it never bricks a developer's loop.
