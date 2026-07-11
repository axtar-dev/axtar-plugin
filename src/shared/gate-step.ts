/**
 * Mentor gate decision — the PURE heart of the PreToolUse gate branch (G1).
 *
 * The engine's `/evaluate` now returns `consult_required`. When TRUE, the
 * hook must consult the Mentor gate before allowing the write. `decideGate`
 * is the pure function the runner uses to turn one gate call into one of
 * three observable decisions: proceed (let the verdict path run), block
 * (exit 2, tell the agent to consult), or bypass (fail-open: allow the edit
 * with a loud advisory + best-effort audit).
 *
 * THE TWO DISCRIMINANTS (reviewed properties):
 *   - Only `gate.ok === true && cleared === false` BLOCKS. That is the one
 *     and only real, server-issued denial.
 *   - ANY `gate.ok === false` (timeout | network | http | invalid_body) FAILS
 *     OPEN. A transport/HTTP outage must never be conflated with a denial:
 *     blocking on an outage would block real work; treating a denial as an
 *     outage would silently disable enforcement. The discriminant is
 *     `gate.ok` — never the reason.
 *
 * The function is intentionally side-effect-free: it only decides and builds
 * the envelope text. The runner does the I/O (gate call, audit POST, emit,
 * exit).
 */

import { isRung2, rung2BlockFraming, rung2EscalationFraming } from './rung.js';
import type { EvaluateResponse, GateResponse } from './wire/schemas.js';

// The result of one /mentor/gate call, mirroring client.gate's EngineResult.
// `null` = gate not called (consult not required); a defensive null when
// consult_required is true must still fail open (rule 5), never crash.
export type GateCall = { ok: true; value: GateResponse } | { ok: false; reason: string } | null;

export interface GateContext {
  session_id: string; // HOST-SOURCED (input.session_id), never agent text
  file_path: string;
  rule_set: string[]; // the applicable rule ids gated on (for the bypass audit/advisory)
}

export type GateDecision =
  | { kind: 'proceed' }
  | { kind: 'block'; message: string; triggered_rule_ids: string[] }
  | { kind: 'bypass'; message: string; triggered_rule_ids: string[] };

/**
 * Build the block envelope. MUST carry the HOST session id (the agent relays
 * it to the consult tool — the trust anchor), the comma-joined triggered rule
 * ids, and an instruction to call the Mentor `consult` MCP tool naming the
 * fields to pass, plus the retry instruction.
 */
function blockMessage(ctx: GateContext, triggeredRuleIds: string[], rung?: string): string {
  const ids = triggeredRuleIds.join(', ');
  const base = [
    'Axtar Mentor: this edit needs consultation before it can proceed.',
    'Call the "consult" tool with:',
    `  session_id: ${ctx.session_id}`,
    `  files: ["${ctx.file_path}"]`,
    '  your question + proposed_edit (or plan)',
    `Governing rules: ${ids}`,
    'After Mentor approves, retry this edit.',
  ].join('\n');
  return isRung2(rung) ? `${base}\n${rung2BlockFraming()}` : base;
}

/**
 * Build the director-aware block envelope (D-052). Only reached when the server
 * returned director `guidance`. Two shapes:
 *   - escalate=true  → handoff framing: surface the guidance and tell the agent
 *     to STOP reworking and hand off to a human (no auto-retry loop).
 *   - escalate=false → the normal consult/retry envelope, with the progressive
 *     guidance framed ahead of the consult instruction.
 * `blockMessage` (the static envelope) is intentionally left untouched; this is
 * a separate path selected by `decideGate` only when guidance is present.
 */
function buildDirectorMessage(ctx: GateContext, gate: GateResponse, rung?: string): string {
  const ids = gate.triggered_rule_ids.join(', ');
  const guidance = gate.guidance ?? '';
  if (gate.escalate) {
    if (isRung2(rung)) {
      // Rung 2 (D-065): the gate stays closed, but the human re-enters at REVIEW —
      // package the impasse into a draft PR, do not hand off mid-session.
      return [
        'Axtar Mentor: this task could not be resolved automatically.',
        guidance,
        `Governing rules: ${ids}`,
        rung2EscalationFraming(),
      ].join('\n');
    }
    return [
      'Axtar Mentor: this task has been escalated for human review.',
      guidance,
      `Governing rules: ${ids}`,
      'Do not retry automatically — a human reviewer must take over.',
    ].join('\n');
  }
  const base = [
    'Axtar Mentor: this edit needs consultation before it can proceed.',
    guidance,
    'Call the "consult" tool with:',
    `  session_id: ${ctx.session_id}`,
    `  files: ["${ctx.file_path}"]`,
    '  your question + proposed_edit (or plan)',
    `Governing rules: ${ids}`,
    'After Mentor approves, retry this edit.',
  ].join('\n');
  return isRung2(rung) ? `${base}\n${rung2BlockFraming()}` : base;
}

/**
 * Build the fail-open advisory. MUST contain the literal phrase
 * "proceeding WITHOUT required consultation" and the rules we gated on
 * (`ctx.rule_set`) — the server didn't respond, so we report what we gated on.
 */
function bypassMessage(ctx: GateContext): string {
  const ids = ctx.rule_set.join(', ');
  return (
    `Axtar Mentor gate unreachable — proceeding WITHOUT required consultation ` +
    `for rules: ${ids}. (The consultation guarantee was waived because the ` +
    `gate could not be reached.)`
  );
}

/**
 * Advisory for hosts WITHOUT the consult tool (v1: codex). The mandatory consult
 * loop is v1-deferred on these hosts; high-altitude edits get a GOVERNANCE ADVISORY,
 * not a mandatory gate. The mandatory codex loop lands in v2.
 */
export function consultUnavailableAdvisory(triggeredRuleIds: string[]): string {
  return (
    `Axtar Mentor (advisory): this is a high-altitude edit governed by rules ` +
    `${triggeredRuleIds.join(', ')}. Mentor consultation is not yet available on this host ` +
    `(v1-deferred) — proceeding with a governance advisory, NOT a mandatory gate. ` +
    `The mandatory consult loop for this host lands in v2.`
  );
}

export function decideGate(
  evaluate: Pick<EvaluateResponse, 'consult_required'>,
  gate: GateCall,
  ctx: GateContext,
  rung?: string,
): GateDecision {
  // 1. Consult not required → proceed (gate may be null).
  if (!evaluate.consult_required) {
    return { kind: 'proceed' };
  }

  // 5. Defensive: consult required but gate was never called → fail open.
  if (gate === null) {
    return {
      kind: 'bypass',
      message: bypassMessage(ctx),
      triggered_rule_ids: ctx.rule_set,
    };
  }

  // 4. ANY transport/HTTP/body failure → fail OPEN (bypass). Never block.
  if (!gate.ok) {
    return {
      kind: 'bypass',
      message: bypassMessage(ctx),
      triggered_rule_ids: ctx.rule_set,
    };
  }

  // 2. Server cleared the edit → proceed.
  if (gate.value.cleared) {
    return { kind: 'proceed' };
  }

  // 3. The ONLY block case: a real, server-issued denial. When the server
  //    supplied director guidance, frame it; otherwise the message is the
  //    byte-identical static envelope. The block discriminant is unchanged.
  const message =
    gate.value.guidance != null
      ? buildDirectorMessage(ctx, gate.value, rung)
      : blockMessage(ctx, gate.value.triggered_rule_ids, rung);
  return {
    kind: 'block',
    message,
    triggered_rule_ids: gate.value.triggered_rule_ids,
  };
}
