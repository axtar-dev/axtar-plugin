/**
 * Codex hook stdin payload — only the fields we read.
 *
 * Per CX-1 findings (`scripts/codex-probe/findings.md` §1):
 *   Common (all hook events):
 *     session_id, transcript_path, cwd, hook_event_name, model, permission_mode
 *   Turn-scoped (PreToolUse / PostToolUse / PermissionRequest / etc.):
 *     + turn_id
 *   PreToolUse: + tool_name, tool_use_id, tool_input
 *   PostToolUse: + tool_name, tool_use_id, tool_input, tool_response
 *
 * Mapping to shared `HookInput`: codex provides `session_id` directly
 * (same field name as Claude Code), so the mapping is identity on every
 * field the shared shape requires — `tool_name`, `tool_input`,
 * `session_id`, `cwd` all pass through. `turn_id`, `tool_use_id`,
 * `permission_mode`, and `tool_response` are host-extras; they survive
 * the parse (`.passthrough()`) but aren't surfaced to the shared
 * interface.
 *
 * Validated leniently with `.passthrough()` — the host sends more than
 * we use, same as the Claude Code side.
 */

import { z } from 'zod';

import type { HookInput } from '../../shared/hook-input.js';
import { trace } from '../../shared/log.js';

export const HookInputSchema = z
  .object({
    session_id: z.string().min(1),
    tool_name: z.string().min(1),
    tool_input: z.record(z.unknown()),
    cwd: z.string().optional(),
    // Turn-scoped fields and PostToolUse extras — present in codex's payload
    // but not part of the shared HookInput contract. Declared for awareness
    // but not enforced; `.passthrough()` lets unknown fields through.
    turn_id: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_response: z.unknown().optional(),
    hook_event_name: z.string().optional(),
    permission_mode: z.string().optional(),
  })
  .passthrough();

export function parseHookInput(raw: string): HookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = HookInputSchema.safeParse(parsed);
  if (!result.success) return null;
  const d = result.data;
  // Long-term shape canary, intentionally retained per [[D-044]]. Emits
  // tool_name + the top-level keys of tool_input — no payload body, no PII,
  // gated on AXTAR_HOOK_TRACE so it costs one boolean compare when off.
  // Codex churns its tool surfaces on a 1–10 day cadence; the apply_patch
  // payload shape just bit us once (the 11.5.4 `tool_input.patch` assumption
  // never matched reality, only the synthetic golden fixtures). This is a
  // deliberate watch on a known-volatile dependency — do not strip it as
  // "leftover diagnostic"; if codex changes the shape again, this line is
  // the first place the change surfaces.
  try {
    const ti = d.tool_input as Record<string, unknown>;
    trace('codex.hook_input.shape', {
      tool_name: d.tool_name,
      tool_input_keys: Object.keys(ti).join(','),
    });
  } catch {
    // tracer must never break the hook
  }
  return {
    tool_name: d.tool_name,
    tool_input: d.tool_input,
    session_id: d.session_id,
    cwd: d.cwd,
  };
}
