/**
 * Codex adapter golden envelopes — D-039 with the 11.5.2 reconciliation.
 *
 * Asserts the exact JSON envelope shape the codex adapter emits for
 * each hook × verdict case:
 *
 *   PostToolUse + advisory →
 *     {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *       "additionalContext":"<rendered>"}}, exit 0
 *
 *   PreToolUse + block →
 *     {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *       "permissionDecision":"deny",
 *       "permissionDecisionReason":"<rendered>"}}, exit 0
 *
 *   any hook + pass → exit 0, no stdout
 *
 *   renderEngineUnreachable(detail) →
 *     PostToolUse-shaped additionalContext envelope, exit 0 (fail-soft
 *     per [[D-014]] and paper §4 — engine down must never block).
 *
 * The CX-2 spike verified both envelope forms surface to the codex
 * agent (Variant A 2026-05-21 PostToolUse additionalContext; Variant C
 * 2026-05-25 PreToolUse permissionDecision:"deny" +
 * permissionDecisionReason). These tests pin the shape so a future
 * envelope-format change doesn't silently regress.
 */

import { describe, expect, it } from 'vitest';

import { codexOutputAdapter } from '../../src/hosts/codex/adapter.js';
import type { EvaluateResponse } from '../../src/shared/wire/schemas.js';

const emptyRuleNames = new Map<string, string>();

function makeResponse(
  verdict: 'block' | 'warn' | 'pass',
  violations: EvaluateResponse['violations'] = [],
): EvaluateResponse {
  return { verdict, violations };
}

function violation(
  overrides: Partial<EvaluateResponse['violations'][number]> = {},
): EvaluateResponse['violations'][number] {
  return {
    rule_id: 'AXT-JAVA-042',
    severity: 'blocking' as const,
    message: 'use BigDecimal for money values',
    foundation: {
      spec: 'specs/money.md',
      rationale: 'In 2022 we hit a €47k rounding bug across 12,000 transactions.',
      authored_by: null,
      enforced_since: null,
    },
    fix_suggestion: 'Replace `double amount` with `BigDecimal amount`.',
    ...overrides,
  };
}

describe('codex output adapter — render envelopes', () => {
  it('pass: returns exit 0 with no stdout and no envelope', () => {
    const e = codexOutputAdapter.render(makeResponse('pass'), {
      hook: 'PostToolUse',
      ruleNames: emptyRuleNames,
    });
    expect(e.exitCode).toBe(0);
    expect(e.stdout).toBeUndefined();
    expect(e.stderr).toBeUndefined();
  });

  it('PreToolUse + block: emits permissionDecision:"deny" envelope on stdout', () => {
    const e = codexOutputAdapter.render(makeResponse('block', [violation()]), {
      hook: 'PreToolUse',
      ruleNames: new Map([['AXT-JAVA-042', 'Money values must use BigDecimal']]),
    });
    expect(e.exitCode).toBe(0);
    expect(e.stderr).toBeUndefined();
    expect(e.stdout).toBeDefined();
    const env = JSON.parse(e.stdout!);
    expect(env).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const reason: string = env.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('Axtar blocked this edit');
    expect(reason).toContain('AXT-JAVA-042 — Money values must use BigDecimal');
    expect(reason).toContain('WHY THIS RULE EXISTS:');
    expect(reason).toContain('€47k rounding bug');
    expect(reason).toContain('WHAT WE FOUND:');
    expect(reason).toContain('HOW TO FIX:');
    expect(reason).toContain('Spec: specs/money.md');
    expect(reason).toContain('Resolve and retry.');
  });

  it('PostToolUse + block: emits additionalContext envelope on stdout', () => {
    const e = codexOutputAdapter.render(makeResponse('block', [violation()]), {
      hook: 'PostToolUse',
      ruleNames: new Map([['AXT-JAVA-042', 'Money values must use BigDecimal']]),
    });
    expect(e.exitCode).toBe(0);
    expect(e.stderr).toBeUndefined();
    expect(e.stdout).toBeDefined();
    const env = JSON.parse(e.stdout!);
    expect(env).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
      },
    });
    const ctx: string = env.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Axtar (post-edit): blocking rule violated');
    expect(ctx).toContain('AXT-JAVA-042 — Money values must use BigDecimal');
    expect(ctx).toContain('Address the violation(s) above before continuing.');
  });

  it('PostToolUse + warn: emits additionalContext envelope (Axtar advisory)', () => {
    const e = codexOutputAdapter.render(
      makeResponse('warn', [violation({ severity: 'warning' })]),
      {
        hook: 'PostToolUse',
        ruleNames: emptyRuleNames,
      },
    );
    expect(e.exitCode).toBe(0);
    const env = JSON.parse(e.stdout!);
    expect(env.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const ctx: string = env.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Axtar advisory');
    expect(ctx).toContain('AXT-JAVA-042');
    expect(ctx).toContain('Note this and continue.');
  });

  it('rule-name lookup misses: rule line degrades to id-only (no crash)', () => {
    const e = codexOutputAdapter.render(makeResponse('block', [violation()]), {
      hook: 'PreToolUse',
      ruleNames: emptyRuleNames,
    });
    const env = JSON.parse(e.stdout!);
    const reason: string = env.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('AXT-JAVA-042'); // id present
    expect(reason).not.toContain('AXT-JAVA-042 — '); // no name suffix
  });

  it('multi-violation: separator between, single closing footer', () => {
    const e = codexOutputAdapter.render(
      makeResponse('block', [
        violation({ rule_id: 'AXT-JAVA-042', message: 'first violation' }),
        violation({ rule_id: 'AXT-JAVA-201', message: 'second violation' }),
      ]),
      {
        hook: 'PreToolUse',
        ruleNames: new Map([
          ['AXT-JAVA-042', 'Money rule'],
          ['AXT-JAVA-201', 'Layering rule'],
        ]),
      },
    );
    const env = JSON.parse(e.stdout!);
    const reason: string = env.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('AXT-JAVA-042 — Money rule');
    expect(reason).toContain('AXT-JAVA-201 — Layering rule');
    expect((reason.match(/WHAT WE FOUND:/g) ?? []).length).toBe(2);
    expect((reason.match(/Resolve and retry\./g) ?? []).length).toBe(1);
    expect(reason).toContain('---'); // inter-violation separator
  });
});

describe('codex output adapter — renderEngineUnreachable', () => {
  it('renders PostToolUse-shaped additionalContext envelope, exit 0 (fail-soft)', () => {
    const e = codexOutputAdapter.renderEngineUnreachable('GET /rules failed');
    expect(e.exitCode).toBe(0);
    expect(e.stderr).toBeUndefined();
    expect(e.stdout).toBeDefined();
    const env = JSON.parse(e.stdout!);
    expect(env).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
      },
    });
    const ctx: string = env.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('engine unreachable');
    expect(ctx).toContain('GET /rules failed');
    expect(ctx).toContain('allowing through');
  });
});
