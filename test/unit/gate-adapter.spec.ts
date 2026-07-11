/**
 * Mentor gate adapter envelopes (G1) — both hosts.
 *
 * The runner renders the gate block/bypass decisions through the host-neutral
 * OutputAdapter seam (`renderMentorBlock`, `renderMentorBypass`). These tests
 * pin each host's mapping:
 *   - Claude Code: block → exit 2 + message on stderr; bypass → exit 0 +
 *     message on stderr.
 *   - Codex: block → permissionDecision:"deny" envelope (exit 0); bypass →
 *     additionalContext envelope (exit 0).
 */

import { describe, expect, it } from 'vitest';

import { claudeCodeOutputAdapter } from '../../src/hosts/claude-code/adapter.js';
import { codexOutputAdapter } from '../../src/hosts/codex/adapter.js';
import { decideGate } from '../../src/shared/gate-step.js';

const BLOCK_MSG = 'Axtar Mentor: consult required\nsession_id: sess-1\nGoverning rules: R1, R2';
const BYPASS_MSG =
  'Axtar Mentor gate unreachable — proceeding WITHOUT required consultation for rules: R1, R2.';

describe('claude-code adapter — mentor gate', () => {
  it('renderMentorBlock → exit 2, message on stderr', () => {
    const e = claudeCodeOutputAdapter.renderMentorBlock(BLOCK_MSG);
    expect(e.exitCode).toBe(2);
    expect(e.stderr).toContain('session_id: sess-1');
    expect(e.stderr).toContain('Governing rules: R1, R2');
    expect(e.stdout ?? '').toBe('');
  });

  it('renderMentorBypass → exit 0, message on stderr', () => {
    const e = claudeCodeOutputAdapter.renderMentorBypass(BYPASS_MSG);
    expect(e.exitCode).toBe(0);
    expect(e.stderr).toContain('proceeding WITHOUT required consultation');
  });
});

describe('claude-code adapter — boxMentor does not split/wrap session_id or rule ids', () => {
  // Regression: the block envelope must relay the host session_id contiguously
  // so the agent can pass it verbatim to the consult MCP tool. A future change
  // to boxMentor introducing width-wrapping would split the UUID mid-string,
  // breaking the trust anchor. This test pins that property end-to-end through
  // the real decideGate → renderMentorBlock pipeline.
  const SESSION_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const LONG_FILE_PATH =
    '/home/runner/work/platform/platform/services/backend/src/main/java/com/example/org/payments/infrastructure/adapters/outbound/persistence/repositories/LedgerEntryJpaRepository.java';
  const TRIGGERED_RULE_IDS = ['AXT-ARC-1', 'AXT-DES-2'];

  it('session_id UUID, triggered rule ids, and exitCode survive boxMentor boxing intact', () => {
    const decision = decideGate(
      { consult_required: true },
      {
        ok: true,
        value: {
          cleared: false,
          triggered_rule_ids: TRIGGERED_RULE_IDS,
          reason: 'consult_required',
        },
      },
      {
        session_id: SESSION_UUID,
        file_path: LONG_FILE_PATH,
        rule_set: TRIGGERED_RULE_IDS,
      },
    );

    // Precondition: decideGate must produce a block decision.
    expect(decision.kind).toBe('block');
    if (decision.kind !== 'block') return;

    const emission = claudeCodeOutputAdapter.renderMentorBlock(decision.message);

    // exitCode 2 is the enforcement signal — must not regress to 0.
    expect(emission.exitCode).toBe(2);

    // The 36-char UUID must appear as one contiguous substring. Any
    // line-width wrapping that splits it breaks the consult tool relay.
    expect(emission.stderr).toContain(SESSION_UUID);

    // Each triggered rule id must also be contiguous (the agent reads them).
    for (const ruleId of TRIGGERED_RULE_IDS) {
      expect(emission.stderr).toContain(ruleId);
    }
  });
});

describe('codex adapter — mentor gate', () => {
  it('renderMentorBlock → deny envelope, exit 0', () => {
    const e = codexOutputAdapter.renderMentorBlock(BLOCK_MSG);
    expect(e.exitCode).toBe(0);
    const parsed = JSON.parse(e.stdout ?? '{}');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(BLOCK_MSG);
  });

  it('renderMentorBypass → additionalContext envelope, exit 0', () => {
    const e = codexOutputAdapter.renderMentorBypass(BYPASS_MSG);
    expect(e.exitCode).toBe(0);
    const parsed = JSON.parse(e.stdout ?? '{}');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(BYPASS_MSG);
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });
});
