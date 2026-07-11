/**
 * Map a Claude Code hook stdin payload to a `PreToolUseRequest`. Returns
 * a discriminated outcome:
 *
 *   - `{ kind: 'evaluate', request }` — caller should POST `request` to engine
 *   - `{ kind: 'skip', reason }` — caller exits 0; engine call would be
 *     meaningless (Bash, file_not_found, ambiguous edit, etc.)
 *   - `{ kind: 'invalid', detail }` — host gave us an unparseable payload
 *
 * `file_path` is resolved against `CLAUDE_PROJECT_DIR` when the host
 * provides a relative path (D-024).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

import { applyEdit, applyWrite } from '../../shared/edit/apply.js';
import { unifiedDiff } from '../../shared/edit/diff.js';
import type { HookInput } from '../../shared/hook-input.js';
import {
  HIGH_ALTITUDES,
  type AssembleOutcome,
  type WrapperOptions,
} from '../../shared/payload-types.js';
import { filterRules, type FilterOptions } from '../../shared/rules/filter.js';
import type { Altitude, RuleSummary, Severity } from '../../shared/wire/schemas.js';
import { EditToolInputSchema, HookInputSchema, WriteToolInputSchema } from './hook-input.js';

// Re-export the shared types so existing test imports
// (`from '../../src/hosts/claude-code/assemble.js'`) continue to compile
// without retargeting. The shared shape is the canonical one; this is
// just an alias for back-compat. The historical Claude-Code-specific
// `tool: 'Edit' | 'Write'` field on the `evaluate` variant was dropped
// — no test or runtime caller reads it.

export interface AssembleOptions {
  rules: readonly RuleSummary[];
  severities: ReadonlySet<Severity>;
  projectDir: string;
  // Which hook the assemble call is serving (Step 10.7 fix). Pre and Post
  // have genuinely different file-state contracts: PreToolUse fires BEFORE
  // the edit lands, so we SIMULATE the edit in memory to derive `file_after`
  // via `applyEdit`. PostToolUse fires AFTER the edit lands, so the
  // post-edit file IS already on disk and we OBSERVE `file_after` via a
  // direct `readFileSync`. Reusing the Pre simulator on Post deterministically
  // fails with `old_string_not_found` because the on-disk file no longer
  // contains `old_string` — Step 10.7 rehearsal surfaced this bug, latent
  // since 10.4 (commit 5770e44) introduced `assembleForPost` and routed both
  // wrappers through the same simulator.
  hookKind: 'pre' | 'post';
  // Mentor gate carve-out altitudes (Mentor v1 bug fix). The Pre wrapper
  // injects `HIGH_ALTITUDES` so high-altitude rules survive the severity filter
  // and reach /evaluate (firing the gate); the Post wrapper leaves it
  // undefined. Passed straight through to `filterRules`.
  gateAltitudes?: ReadonlySet<Altitude>;
}

// Build the `filterRules` options from the assemble options — keeps the
// engine/gate-altitude pass-through in one place so the three call sites
// (Edit/Write Pre, Post observe) cannot drift.
function ruleFilterOptions(options: AssembleOptions): FilterOptions {
  return {
    severities: options.severities,
    ...(options.gateAltitudes === undefined ? {} : { gateAltitudes: options.gateAltitudes }),
  };
}

export function parseHookInput(raw: string): HookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = HookInputSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function assemble(input: HookInput, options: AssembleOptions): AssembleOutcome {
  const tool = input.tool_name;

  if (tool === 'Edit') {
    return assembleEdit(input, options);
  }
  if (tool === 'Write') {
    return assembleWrite(input, options);
  }
  // The 11.5.5 matcher widening (per D-041 Group A) added Bash and MCP
  // filesystem-write tools to the hook matcher. The hook now FIRES on
  // those tools but the engine has no content-level Bash-lane evaluation
  // yet (deferred per D-042-placeholder). Logs-and-allows-through:
  // returns `skip`, the runner traces `assemble.skip { reason }` and
  // exits 0. Closes the matcher visibility gap; the content-level
  // blocking on Bash/MCP-write surfaces follows when D-042 resolves.
  if (tool === 'Bash' || tool.startsWith('mcp__')) {
    return {
      kind: 'skip',
      reason: `tool ${tool} matched (D-041 widening) but engine Bash-lane / MCP-write evaluation is deferred (D-042-placeholder)`,
    };
  }
  return { kind: 'skip', reason: `tool ${tool} is not gated by Axtar` };
}

function resolvePath(filePath: string, projectDir: string): string {
  return isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
}

// PostToolUse observer: the edit has already landed, so the post-edit file
// IS already on disk. Read `file_after` directly; the simulator in
// `apply.ts` is for Pre only. `diff` is empty because PostToolUse detection is
// LLM-only (D-035) and the LLM adapter consumes only `file_after`. Single
// engine (D-046): no deterministic detector needs a diff on Post.
function assemblePostObserve(
  toolName: 'Edit' | 'Write',
  filePath: string,
  sessionId: string,
  options: AssembleOptions,
): AssembleOutcome {
  if (!existsSync(filePath)) {
    return { kind: 'skip', reason: 'PostToolUse: file not found on disk' };
  }
  const fileAfter = readFileSync(filePath, 'utf-8');
  const ruleSet = filterRules(options.rules, filePath, ruleFilterOptions(options)).map((r) => r.id);
  return {
    kind: 'evaluate',
    request: {
      session_id: sessionId,
      tool: toolName,
      file_path: filePath,
      diff: '',
      file_after: fileAfter,
      rule_set: ruleSet,
      gate_check: options.hookKind === 'pre',
    },
  };
}

function assembleEdit(input: HookInput, options: AssembleOptions): AssembleOutcome {
  const parsed = EditToolInputSchema.safeParse(input.tool_input);
  if (!parsed.success) {
    return { kind: 'invalid', detail: `Edit tool_input: ${parsed.error.message}` };
  }
  const filePath = resolvePath(parsed.data.file_path, options.projectDir);

  if (options.hookKind === 'post') {
    return assemblePostObserve('Edit', filePath, input.session_id, options);
  }

  // Pre: simulate the edit in memory so we have `file_after` before the
  // host lands it.
  const outcome = applyEdit({
    file_path: filePath,
    old_string: parsed.data.old_string,
    new_string: parsed.data.new_string,
    ...(parsed.data.replace_all === undefined ? {} : { replace_all: parsed.data.replace_all }),
  });
  if (outcome.kind !== 'ok') {
    return { kind: 'skip', reason: `Edit pre-conditions: ${outcome.kind}` };
  }

  const ruleSet = filterRules(options.rules, filePath, ruleFilterOptions(options)).map((r) => r.id);

  return {
    kind: 'evaluate',
    request: {
      session_id: input.session_id,
      tool: 'Edit',
      file_path: filePath,
      diff: unifiedDiff(outcome.file_before, outcome.file_after, filePath, filePath),
      file_after: outcome.file_after,
      rule_set: ruleSet,
      gate_check: options.hookKind === 'pre',
    },
  };
}

function assembleWrite(input: HookInput, options: AssembleOptions): AssembleOutcome {
  const parsed = WriteToolInputSchema.safeParse(input.tool_input);
  if (!parsed.success) {
    return { kind: 'invalid', detail: `Write tool_input: ${parsed.error.message}` };
  }
  const filePath = resolvePath(parsed.data.file_path, options.projectDir);

  if (options.hookKind === 'post') {
    return assemblePostObserve('Write', filePath, input.session_id, options);
  }

  // Pre: simulate the write in memory so we have `file_after` before the
  // host lands it.
  const outcome = applyWrite({
    file_path: filePath,
    content: parsed.data.content,
  });
  if (outcome.kind !== 'ok') {
    return { kind: 'skip', reason: `Write pre-conditions: ${outcome.kind}` };
  }

  const ruleSet = filterRules(options.rules, filePath, ruleFilterOptions(options)).map((r) => r.id);

  return {
    kind: 'evaluate',
    request: {
      session_id: input.session_id,
      tool: 'Write',
      file_path: filePath,
      diff: unifiedDiff(outcome.file_before, outcome.file_after, filePath, filePath),
      file_after: outcome.file_after,
      rule_set: ruleSet,
      gate_check: options.hookKind === 'pre',
    },
  };
}

// Hook-facing wrappers — keep hook entry points hookKind-blind. The Pre-vs-Post
// asymmetry lives here; callers (the runner) just supply
// `rules / severities / projectDir`. `WrapperOptions` re-exported from shared
// above. Single-engine product (D-046/D-049): there is no engine partition; the
// only Pre/Post difference is `gate_check` (server-side detection deferral) and
// the Pre-only gate carve-out (`HIGH_ALTITUDES`).
export function assembleForPre(input: HookInput, options: WrapperOptions): AssembleOutcome {
  return assemble(input, {
    ...options,
    hookKind: 'pre',
    gateAltitudes: HIGH_ALTITUDES,
  });
}

export function assembleForPost(input: HookInput, options: WrapperOptions): AssembleOutcome {
  return assemble(input, { ...options, hookKind: 'post' });
}
