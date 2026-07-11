import { describe, it, expect } from 'vitest';
import {
  EvaluateResponseSchema,
  GateRequestSchema,
  GateResponseSchema,
  ConsultRequestSchema,
  ConsultResponseSchema,
} from '../../src/shared/wire/schemas.js';

describe('consult_required additive resolution', () => {
  it('accepts an engine response carrying consult_required:true (the .strict() fix)', () => {
    const r = EvaluateResponseSchema.parse({
      verdict: 'block',
      violations: [],
      consult_required: true,
    });
    expect(r.consult_required).toBe(true);
  });
  it('defaults consult_required to false when an older engine omits it', () => {
    const r = EvaluateResponseSchema.parse({ verdict: 'pass', violations: [] });
    expect(r.consult_required).toBe(false);
  });
});

describe('gate + consult schemas', () => {
  it('GateRequest/GateResponse round-trip', () => {
    expect(
      GateRequestSchema.parse({ session_id: 's', file_path: '/x', rule_set: [] }).session_id,
    ).toBe('s');
    expect(
      GateResponseSchema.parse({
        cleared: false,
        triggered_rule_ids: ['AXT-ARC-1'],
        reason: 'consult_required',
      }).cleared,
    ).toBe(false);
  });
  it('ConsultRequest requires >=1 file; ConsultResponse parses a verdict', () => {
    expect(ConsultRequestSchema.parse({ session_id: 's', files: ['/x'] }).files.length).toBe(1);
    expect(() => ConsultRequestSchema.parse({ session_id: 's', files: [] })).toThrow();
    expect(
      ConsultResponseSchema.parse({
        answer: 'a',
        verdict: 'approve',
        rationale: 'r',
        approved_files: [],
        follow_up_questions: [],
      }).verdict,
    ).toBe('approve');
  });
});
