/**
 * Host-neutral shape the shared runner needs from any host's parsed
 * stdin. Each host's `hook-input.ts` validates host-specific stdin and
 * produces a value that conforms to this interface.
 *
 * The fields are the intersection of what Claude Code and Codex hooks
 * both naturally provide (CX-1):
 *   - `tool_name`     — name of the tool being invoked (e.g. "Edit",
 *                       "Write", "apply_patch", "Bash"). Cross-host.
 *   - `tool_input`    — opaque dict the host passes through; host
 *                       adapters narrow it per-tool with their own Zod
 *                       schemas.
 *   - `session_id`    — stable identifier the host attaches to the hook
 *                       firing. Codex's mapping to this field is
 *                       host-internal (Codex may derive from
 *                       `turn_id`/`tool_use_id`).
 *   - `cwd`           — optional working dir the host advertises;
 *                       runner falls back to `CLAUDE_PROJECT_DIR` /
 *                       `process.cwd()` when absent.
 *
 * Why a shared shape here (vs. injecting a fully-typed parser per
 * host): the runner needs to log `tool_name`, `session_id`, and a
 * `file_path` hint extracted from `tool_input` before calling assemble.
 * Keeping the type host-neutral lets the runner stay host-blind without
 * generics on `RunOptions`. The design call is recorded in the
 * Step 11.5.2 commit message — extracting this shape is the natural
 * closure of the `hook-input` upward import that 11.5.1b introduced;
 * the alternative (combined parse+assemble, runner never sees parsed
 * input) was considered and rejected as it drops the
 * `runner.stdin.parsed` trace event that informs `prefilter.result`.
 */

export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
  // `cwd?: string | undefined` (not `cwd?: string`) to match what Zod's
  // `.optional()` produces under `exactOptionalPropertyTypes: true` —
  // Zod's inferred type allows `cwd: undefined` explicitly, which a
  // bare `cwd?: string` would reject.
  cwd?: string | undefined;
}
