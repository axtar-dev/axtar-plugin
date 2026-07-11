/**
 * `OutputAdapter` — host-neutral seam between the shared runner and each
 * host's stream/envelope rendering (D-039).
 *
 * The adapter is a *pure function* family: it takes a host-neutral
 * `EvaluateResponse` and a `RenderContext` and returns a host-neutral
 * `HookEmission` descriptor (what stream content + which exit code). The
 * shared runner performs the actual emit (write streams, exit) and stays
 * host-blind.
 *
 * Method surface:
 *   - `render(response, context)` — the verdict-rendering path.
 *   - `renderEngineUnreachable(detail)` — the degraded path when the
 *     engine is not reachable. Each host renders this differently (Claude
 *     Code uses stderr + exit 0; codex uses its JSON envelope mechanism),
 *     so it lives behind the same adapter seam as `render`. D-039's
 *     interface spec named `render` only; this is the natural extension
 *     for the degraded path that `verdict.ts` already owned (as the
 *     `renderEngineUnreachable` free function before the wrap).
 */

import type { EvaluateResponse } from '../wire/schemas.js';

export interface RenderContext {
  hook: 'PreToolUse' | 'PostToolUse';
  // rule_id → Rule.name, from the per-hook `/rules` cache (D-020, D-029).
  // Pass an empty Map for the degraded "no name available" path; the
  // formatter falls back to id-only.
  ruleNames: ReadonlyMap<string, string>;
  // v1 PostToolUse Mentor reminder text, appended to the Post output. Undefined on Pre.
  driftAdvisory?: string;
  // Rung-2 heartbeat text (D-063 secondary). Set only for PostToolUse under Rung 2;
  // the host adapter emits it on the exit-0 additionalContext channel. Undefined otherwise.
  rungHeartbeat?: string;
}

export interface HookEmission {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface OutputAdapter {
  render(response: EvaluateResponse, context: RenderContext): HookEmission;
  renderEngineUnreachable(detail: string): HookEmission;
  /**
   * Mentor gate BLOCK (G1) — a real, server-issued denial. The agent must
   * consult before the edit can proceed. Claude Code: exit 2 + the message on
   * stderr (the enforcement form, like a verdict block). Codex: the
   * `permissionDecision: "deny"` envelope carrying the message as the reason.
   */
  renderMentorBlock(message: string): HookEmission;
  /**
   * Mentor gate BYPASS (G1) — fail-open advisory when the gate is unreachable.
   * Allows the edit (exit 0) but surfaces a loud "proceeding WITHOUT required
   * consultation" advisory. Claude Code: exit 0 + message on stderr. Codex:
   * the `additionalContext` advisory envelope, exit 0.
   */
  renderMentorBypass(message: string): HookEmission;
}
