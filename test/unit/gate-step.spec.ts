/**
 * Pure `decideGate` tests (G1) — the reviewed properties of the Mentor gate
 * decision. The bulk of the suite asserts envelope CONTENT, because the
 * envelope text is the observable contract: the block message MUST carry the
 * host session id (the trust anchor the agent relays to the consult tool),
 * and the bypass message MUST carry the loud "proceeding WITHOUT required
 * consultation" phrase.
 *
 * The two load-bearing discriminants:
 *   - ONLY `gate.ok === true && cleared === false` blocks.
 *   - EVERY `gate.ok === false` (timeout | network | http | invalid_body)
 *     fails OPEN (bypass). None of them block.
 */

import { describe, expect, it } from 'vitest';

import {
  consultUnavailableAdvisory,
  decideGate,
  type GateCall,
  type GateContext,
} from '../../src/shared/gate-step.js';
import type { GateResponse } from '../../src/shared/wire/schemas.js';

const SESSION = 'host-session-abc-123';
const ctx: GateContext = {
  session_id: SESSION,
  file_path: '/repo/src/Money.java',
  rule_set: ['AXT-JAVA-042', 'AXT-ARCH-007'],
};

function cleared(): GateCall {
  const value: GateResponse = { cleared: true, triggered_rule_ids: [], reason: '' };
  return { ok: true, value };
}

function denied(ids: string[]): GateCall {
  const value: GateResponse = {
    cleared: false,
    triggered_rule_ids: ids,
    reason: 'must consult',
  };
  return { ok: true, value };
}

describe('decideGate — proceed paths', () => {
  it('1. consult_required:false → proceed (gate null)', () => {
    const d = decideGate({ consult_required: false }, null, ctx);
    expect(d.kind).toBe('proceed');
  });

  it('2. gate cleared → proceed', () => {
    const d = decideGate({ consult_required: true }, cleared(), ctx);
    expect(d.kind).toBe('proceed');
  });
});

describe('decideGate — block path (the ONLY denial)', () => {
  it('3. gate ok + NOT cleared → block; envelope carries session id, rules, consult + retry', () => {
    const triggered = ['AXT-JAVA-042', 'AXT-SEC-009'];
    const d = decideGate({ consult_required: true }, denied(triggered), ctx);

    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');

    // SESSION-ID-PRESENCE requirement: the host session id is the trust
    // anchor the agent relays to the consult tool. Assert it explicitly.
    expect(d.message).toContain(SESSION);

    // Each triggered rule id from the SERVER response appears.
    for (const id of triggered) {
      expect(d.message).toContain(id);
    }
    expect(d.triggered_rule_ids).toEqual(triggered);

    // Names the consult tool and the retry instruction.
    expect(d.message).toContain('consult');
    expect(d.message.toLowerCase()).toContain('retry');
    // Names the fields the agent must pass.
    expect(d.message).toContain('session_id');
    expect(d.message).toContain('files');
    expect(d.message).toContain(ctx.file_path);
  });

  it('4. discriminant sanity — only ok:true+!cleared blocks; cleared does NOT block', () => {
    expect(decideGate({ consult_required: true }, denied(['X']), ctx).kind).toBe('block');
    expect(decideGate({ consult_required: true }, cleared(), ctx).kind).toBe('proceed');
  });
});

describe('decideGate — fail-open discriminant (ANY ok:false → bypass, NEVER block)', () => {
  const reasons = ['timeout', 'network', 'http', 'invalid_body'] as const;

  for (const reason of reasons) {
    it(`5. gate {ok:false, reason:'${reason}'} → bypass (allow), never block`, () => {
      const d = decideGate({ consult_required: true }, { ok: false, reason }, ctx);

      expect(d.kind).toBe('bypass');
      if (d.kind !== 'bypass') throw new Error('expected bypass');

      // The fail-open advisory MUST carry the loud literal phrase + the rules
      // we gated on (server didn't respond, so we report ctx.rule_set).
      expect(d.message).toContain('proceeding WITHOUT required consultation');
      for (const id of ctx.rule_set) {
        expect(d.message).toContain(id);
      }
      expect(d.triggered_rule_ids).toEqual(ctx.rule_set);
    });
  }

  it('5b. none of the ok:false reasons produce a block', () => {
    for (const reason of reasons) {
      const d = decideGate({ consult_required: true }, { ok: false, reason }, ctx);
      expect(d.kind).not.toBe('block');
    }
  });
});

describe('consultUnavailableAdvisory — hosts without the bundled consult tool', () => {
  it('names the triggered rules and states the v1-deferred / advisory-not-mandatory-gate boundary', () => {
    const msg = consultUnavailableAdvisory(['AXT-ARC-1', 'AXT-DES-2']);

    // Names each triggered rule id.
    expect(msg).toContain('AXT-ARC-1');
    expect(msg).toContain('AXT-DES-2');

    // Honest advisory framing (NOT a mandatory gate).
    expect(msg.toLowerCase()).toContain('advisory');
    expect(msg).toContain('not yet available');
    expect(msg).toContain('NOT a mandatory gate');

    // Names the v1/v2 boundary.
    expect(msg).toContain('v2');
  });
});

describe('decideGate — defensive null when consult required', () => {
  it('6. consult_required:true + gate null → bypass (fail open, do not crash)', () => {
    const d = decideGate({ consult_required: true }, null, ctx);
    expect(d.kind).toBe('bypass');
    if (d.kind !== 'bypass') throw new Error('expected bypass');
    expect(d.message).toContain('proceeding WITHOUT required consultation');
    expect(d.triggered_rule_ids).toEqual(ctx.rule_set);
  });
});

// ---------------------------------------------------------------------------
// Director guidance in the block envelope (D-052) — Task 3.5.
// The block discriminant is UNCHANGED (still only ok:true+!cleared blocks);
// only the block *message text* gains a director-aware branch. Absent the
// director fields, the envelope is byte-identical to the static one.
// ---------------------------------------------------------------------------

function deniedWithDirector(
  ids: string[],
  fields: { guidance?: string | null; escalate?: boolean; attempt?: number | null },
): GateCall {
  const value: GateResponse = {
    cleared: false,
    triggered_rule_ids: ids,
    reason: 'must consult',
    ...fields,
  };
  return { ok: true, value };
}

describe('decideGate — director guidance in the block envelope (D-052)', () => {
  it('7. guidance present → block frames the guidance AND keeps consult/session/retry', () => {
    const guidance =
      'You attempted this edit before; it still triggers AXT-ARC-1 (attempt 2).\n' +
      'The mentor previously said: "violates AXT-ARC-1"';
    const d = decideGate(
      { consult_required: true },
      deniedWithDirector(['AXT-ARC-1'], { guidance, escalate: false, attempt: 2 }),
      ctx,
    );

    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');

    // The director's words are surfaced verbatim.
    expect(d.message).toContain(guidance);
    // Still the trust anchor + the consult/retry loop (non-escalation path).
    expect(d.message).toContain(SESSION);
    expect(d.message).toContain('consult');
    expect(d.message.toLowerCase()).toContain('retry');
    expect(d.message).toContain(ctx.file_path);
    expect(d.triggered_rule_ids).toEqual(['AXT-ARC-1']);
  });

  it('8. escalate:true → block surfaces handoff text (no auto-retry), still blocks', () => {
    const handoff =
      'This task has been blocked 3 time(s) without converging on AXT-ARC-1. ' +
      'Stop reworking and hand off to a human reviewer.';
    const d = decideGate(
      { consult_required: true },
      deniedWithDirector(['AXT-ARC-1'], { guidance: handoff, escalate: true, attempt: 3 }),
      ctx,
    );

    // Escalation is still a block — the gate stays closed; a human takes over.
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');

    expect(d.message).toContain(handoff);
    expect(d.message.toLowerCase()).toContain('human');
    expect(d.triggered_rule_ids).toEqual(['AXT-ARC-1']);
  });

  it('9. no director fields → block message is BYTE-IDENTICAL to the static envelope', () => {
    const triggered = ['AXT-ARC-1', 'AXT-DES-2'];
    const expected = [
      'Axtar Mentor: this edit needs consultation before it can proceed.',
      'Call the "consult" tool with:',
      `  session_id: ${SESSION}`,
      `  files: ["${ctx.file_path}"]`,
      '  your question + proposed_edit (or plan)',
      `Governing rules: ${triggered.join(', ')}`,
      'After Mentor approves, retry this edit.',
    ].join('\n');

    const d = decideGate({ consult_required: true }, denied(triggered), ctx);
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');
    expect(d.message).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Rung 2 framing in the block envelope (D-063 / D-064 / D-065) — Phase 2.
// decideGate gains an optional `rung`. The discriminant is UNCHANGED; only the
// block message text branches. rung absent / 'rung1_autonomous_fix' → BYTE-
// IDENTICAL to today. 'rung2_gate_certified' → standing authorization (+ the
// draft-PR escalate envelope).
// ---------------------------------------------------------------------------

const RUNG2 = 'rung2_gate_certified';
const RUNG1 = 'rung1_autonomous_fix';

describe('decideGate — Rung 2 framing (D-063)', () => {
  it('10. rung2 + plain denial → block carries the standing authorization AND the consult/retry loop', () => {
    const d = decideGate({ consult_required: true }, denied(['AXT-ARC-1']), ctx, RUNG2);
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');
    // The authorization is an owner decision the agent HONORS: provenance (the
    // owner configured this) + result-not-steps review. It must never be an
    // order away from the human — this text arrives as tool output, and a
    // "do not ask the human" imperative there reads as prompt injection to an
    // aligned model, which then refuses the whole authorization.
    expect(d.message).toContain('Rung 2');
    expect(d.message.toLowerCase()).toContain('configured');
    expect(d.message.toLowerCase()).toContain('owner');
    expect(d.message.toLowerCase()).toContain('honors');
    expect(d.message.toLowerCase()).not.toContain('do not stop to ask');
    expect(d.message.toLowerCase()).not.toContain("don't stop to ask");
    // No PR pre-instruction: the block fires before any fix exists, so "open a
    // pull request" here is premature, mislocated (post-approval workflow, not
    // block content), and the specific embedded instruction aligned agents flag.
    // The block's instructed workflow ends at consult → implement → retry.
    expect(d.message.toLowerCase()).not.toContain('pull request');
    // The judgment-calls disclosure stays, attached to the resolution summary
    // (the closing message) — it feeds a PR body only if the human's workflow
    // opens one downstream, which is not the block's concern.
    expect(d.message).toContain('session_summary');
    expect(d.message.toLowerCase()).toContain('resolution summary');
    // Still the consult/retry loop + the trust anchor.
    expect(d.message).toContain(SESSION);
    expect(d.message).toContain('consult');
    expect(d.message.toLowerCase()).toContain('retry');
  });

  it('11. rung2 + escalate → block routes to a DRAFT PR (no "human must take over"), still blocks', () => {
    const substance =
      'Could not reach a compliant solution after 2 attempt(s); AXT-ARC-1 still triggers.\n' +
      'The mentor\'s last rationale: "still violates AXT-ARC-1"';
    const d = decideGate(
      { consult_required: true },
      deniedWithDirector(['AXT-ARC-1'], { guidance: substance, escalate: true, attempt: 3 }),
      ctx,
      RUNG2,
    );
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');
    // Server impasse substance rendered verbatim.
    expect(d.message).toContain(substance);
    // Rung-2 action: a DRAFT PR, NOT a mid-session human handoff.
    expect(d.message.toLowerCase()).toContain('draft');
    expect(d.message.toLowerCase()).toContain('pull request');
    expect(d.message).not.toContain('a human reviewer must take over');
    // No prohibition on reaching the human — the draft PR IS the owner's chosen
    // channel for impasses, so the text frames it as contact, not avoidance.
    expect(d.message.toLowerCase()).not.toContain('do not ask the human');
  });

  it('12. rung1 (explicit) + denial → block message BYTE-IDENTICAL to the static envelope', () => {
    const triggered = ['AXT-ARC-1', 'AXT-DES-2'];
    const expected = [
      'Axtar Mentor: this edit needs consultation before it can proceed.',
      'Call the "consult" tool with:',
      `  session_id: ${SESSION}`,
      `  files: ["${ctx.file_path}"]`,
      '  your question + proposed_edit (or plan)',
      `Governing rules: ${triggered.join(', ')}`,
      'After Mentor approves, retry this edit.',
    ].join('\n');
    const d = decideGate({ consult_required: true }, denied(triggered), ctx, RUNG1);
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');
    expect(d.message).toBe(expected);
  });

  it('13. rung2 + director non-escalate guidance → frames guidance AND appends the authorization', () => {
    const guidance = 'You attempted this edit before; it still triggers AXT-ARC-1 (attempt 2).';
    const d = decideGate(
      { consult_required: true },
      deniedWithDirector(['AXT-ARC-1'], { guidance, escalate: false, attempt: 2 }),
      ctx,
      RUNG2,
    );
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') throw new Error('expected block');
    expect(d.message).toContain(guidance); // director substance preserved
    expect(d.message).toContain('Rung 2'); // + the standing authorization
    expect(d.message).toContain('consult');
  });
});
