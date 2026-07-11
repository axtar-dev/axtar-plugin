import { describe, expect, it } from 'vitest';
import {
  ConsultResponseSchema,
  EvaluateResponseSchema,
  GateResponseSchema,
  PolicyResponseSchema,
  PreToolUseRequestSchema,
  RuleSummarySchema,
  ViolationSchema,
} from '../../src/shared/wire/schemas.js';

describe('PreToolUseRequestSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = PreToolUseRequestSchema.safeParse({
      session_id: 'abc',
      tool: 'Edit',
      file_path: '/x/y.java',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rule_set).toEqual([]);
    }
  });

  it('rejects missing rule_set (required by wire contract)', () => {
    const result = PreToolUseRequestSchema.safeParse({
      session_id: 'abc',
      tool: 'Edit',
      file_path: '/x/y.java',
      diff: '',
      file_after: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (mirrors Pydantic extra="forbid")', () => {
    const result = PreToolUseRequestSchema.safeParse({
      session_id: 'abc',
      tool: 'Edit',
      file_path: '/x/y.java',
      diff: '',
      file_after: '',
      rule_set: [],
      surprise: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty session_id', () => {
    const result = PreToolUseRequestSchema.safeParse({
      session_id: '',
      tool: 'Edit',
      file_path: '/x/y.java',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('EvaluateResponseSchema', () => {
  it('accepts a pass verdict with explicit empty violations', () => {
    const result = EvaluateResponseSchema.safeParse({ verdict: 'pass', violations: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.violations).toEqual([]);
    }
  });

  it('rejects missing violations (required by wire contract)', () => {
    const result = EvaluateResponseSchema.safeParse({ verdict: 'pass' });
    expect(result.success).toBe(false);
  });

  it('accepts a block verdict with a full violation', () => {
    const result = EvaluateResponseSchema.safeParse({
      verdict: 'block',
      violations: [
        {
          rule_id: 'AXT-JAVA-042',
          severity: 'blocking',
          message: 'no float money',
          foundation: { spec: 's', rationale: 'r', authored_by: null, enforced_since: null },
          fix_suggestion: 'use BigDecimal',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown verdict', () => {
    const result = EvaluateResponseSchema.safeParse({ verdict: 'kaboom' });
    expect(result.success).toBe(false);
  });
});

describe('ViolationSchema', () => {
  it('accepts violation with null foundation', () => {
    const result = ViolationSchema.safeParse({
      rule_id: 'X',
      severity: 'warning',
      message: 'm',
    });
    expect(result.success).toBe(true);
  });

  it('rejects extra fields like rule_name (D-029: name lives in /rules cache, not on wire)', () => {
    const result = ViolationSchema.safeParse({
      rule_id: 'X',
      rule_name: 'Extra Renamed',
      severity: 'warning',
      message: 'm',
    });
    expect(result.success).toBe(false);
  });
});

describe('RuleSummarySchema', () => {
  it('requires the paths field', () => {
    const ok = RuleSummarySchema.safeParse({
      id: 'AXT-JAVA-042',
      name: 'money',
      altitude: 'implementation',
      severity: 'blocking',
      language: 'java',
      paths: ['**/domain/**/*.java'],
    });
    expect(ok.success).toBe(true);

    const missing = RuleSummarySchema.safeParse({
      id: 'AXT-JAVA-042',
      name: 'money',
      altitude: 'implementation',
      severity: 'blocking',
      language: 'java',
    });
    expect(missing.success).toBe(false);
  });
});

describe('GateResponseSchema', () => {
  it('accepts a response without director fields (old server)', () => {
    const result = GateResponseSchema.safeParse({
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'consult_required',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a response with director fields (new server) — D-052', () => {
    const result = GateResponseSchema.safeParse({
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'consult_required',
      guidance: 'Stop reworking and hand off to a human reviewer.',
      escalate: true,
      attempt: 3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields (mirrors Pydantic extra="forbid")', () => {
    const result = GateResponseSchema.safeParse({
      cleared: false,
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'consult_required',
      surprise: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('ConsultResponseSchema', () => {
  it('accepts a response without determinacy fields (old server)', () => {
    const result = ConsultResponseSchema.safeParse({
      answer: 'a',
      verdict: 'approve',
      rationale: 'r',
      approved_files: [],
      follow_up_questions: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a response with determinacy fields (new server) — D-060', () => {
    const result = ConsultResponseSchema.safeParse({
      answer: 'a',
      verdict: 'approve',
      rationale: 'r',
      approved_files: [],
      follow_up_questions: [],
      determinacy: 'underdetermined',
      underdetermined_choices: [{ decision: 'd', alternatives: 'a', why_unconstrained: 'w' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed underdetermined_choice (missing required field)', () => {
    const result = ConsultResponseSchema.safeParse({
      answer: 'a',
      verdict: 'approve',
      rationale: 'r',
      approved_files: [],
      follow_up_questions: [],
      underdetermined_choices: [{ decision: 'd', alternatives: 'a' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('PolicyResponseSchema', () => {
  it('accepts a resolved rung', () => {
    expect(PolicyResponseSchema.safeParse({ autonomy_rung: 'rung2_gate_certified' }).success).toBe(
      true,
    );
    expect(PolicyResponseSchema.safeParse({ autonomy_rung: 'rung1_autonomous_fix' }).success).toBe(
      true,
    );
  });
  it('rejects a missing autonomy_rung', () => {
    expect(PolicyResponseSchema.safeParse({}).success).toBe(false);
  });
  it('rejects unknown fields (mirrors Pydantic extra="forbid")', () => {
    expect(PolicyResponseSchema.safeParse({ autonomy_rung: 'x', surprise: 1 }).success).toBe(false);
  });
});
