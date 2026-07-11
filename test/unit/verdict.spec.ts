import { describe, expect, it } from 'vitest';

import { renderVerdict } from '../../src/hosts/claude-code/adapter.js';
import type { EvaluateResponse, Violation } from '../../src/shared/wire/schemas.js';

const fullViolation: Violation = {
  rule_id: 'AXT-JAVA-042',
  severity: 'blocking',
  message: 'Field `price` appears to represent money but uses a floating-point type.',
  foundation: {
    spec: 'specs/money-handling.md#types',
    rationale: 'In 2022 we hit a €47k rounding bug across 12,000 small transactions.',
    authored_by: 'platform-team',
    enforced_since: '2024-Q1',
  },
  fix_suggestion: 'Replace with: BigDecimal price = BigDecimal.ZERO;',
};

const blockingResp: EvaluateResponse = {
  verdict: 'block',
  violations: [fullViolation],
};

// The runner builds this from the `/rules` cache (D-020) and passes it
// to `renderVerdict`. Tests construct the lookup directly.
const ruleNames = new Map<string, string>([
  ['AXT-JAVA-042', 'Money values must use BigDecimal'],
  ['AXT-JAVA-077', 'No System.out.println'],
  ['AXT-JAVA-201', 'Controller must not depend on Repository directly'],
]);

describe('renderVerdict — PreToolUse', () => {
  it('block → exit 2 + structured stderr', () => {
    const r = renderVerdict(blockingResp, { hook: 'PreToolUse', ruleNames });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Axtar blocked this edit');
    expect(r.stderr).toContain('AXT-JAVA-042 — Money values must use BigDecimal');
    expect(r.stderr).toContain('WHY THIS RULE EXISTS:');
    expect(r.stderr).toContain('€47k');
    expect(r.stderr).toContain('WHAT WE FOUND:');
    expect(r.stderr).toContain('HOW TO FIX:');
    expect(r.stderr).toContain('BigDecimal.ZERO');
    expect(r.stderr).toContain('Spec: specs/money-handling.md#types');
    expect(r.stderr).toContain('Authored by platform-team · enforced since 2024-Q1.');
    expect(r.stderr).toContain('Resolve and retry.');
  });

  it('block snapshot — full layout, single violation', () => {
    const r = renderVerdict(blockingResp, { hook: 'PreToolUse', ruleNames });
    expect(r.stderr).toMatchInlineSnapshot(`
      "─── Axtar blocked this edit ──────────────────────────────────────

        AXT-JAVA-042 — Money values must use BigDecimal

        WHY THIS RULE EXISTS:
          In 2022 we hit a €47k rounding bug across 12,000 small transactions.

        WHAT WE FOUND:
          Field \`price\` appears to represent money but uses a floating-point type.

        HOW TO FIX:
          Replace with: BigDecimal price = BigDecimal.ZERO;

        Spec: specs/money-handling.md#types
        Authored by platform-team · enforced since 2024-Q1.

      ──────────────────────────────────────────────────────────────────
      Resolve and retry.
      "
    `);
  });

  it('falls back to id-only when the cache misses for a rule_id (D-029)', () => {
    // Empty lookup map — simulates the degraded path where the /rules
    // cache returned successfully but the engine surfaced a violation
    // for a rule that wasn't in the cache snapshot (e.g., race between
    // cache TTL and rule reload). Must not crash; must render the id.
    const r = renderVerdict(blockingResp, {
      hook: 'PreToolUse',
      ruleNames: new Map(),
    });
    expect(r.exitCode).toBe(2);
    // Just the rule_id, no `— <name>` suffix and no stray em-dash.
    expect(r.stderr).toContain('  AXT-JAVA-042\n');
    expect(r.stderr).not.toContain('AXT-JAVA-042 —');
  });

  it('warn → exit 0 + advisory header + footer', () => {
    const r = renderVerdict(
      {
        verdict: 'warn',
        violations: [
          {
            rule_id: 'AXT-JAVA-077',
            severity: 'warning',
            message: 'Use a logger instead of System.out.println.',
            foundation: null,
            fix_suggestion: null,
          },
        ],
      },
      { hook: 'PreToolUse', ruleNames },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Axtar advisory');
    expect(r.stderr).toContain('AXT-JAVA-077 — No System.out.println');
    expect(r.stderr).toContain('WHAT WE FOUND:');
    expect(r.stderr).toContain('Note this and continue.');
  });

  it('pass → exit 0 + empty stderr', () => {
    const r = renderVerdict({ verdict: 'pass', violations: [] }, { hook: 'PreToolUse', ruleNames });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('omits WHY block when rationale is absent (no empty header)', () => {
    const r = renderVerdict(
      {
        verdict: 'block',
        violations: [
          {
            ...fullViolation,
            foundation: {
              spec: 'specs/x.md',
              rationale: null,
              authored_by: 'platform-team',
              enforced_since: '2024-Q1',
            },
          },
        ],
      },
      { hook: 'PreToolUse', ruleNames },
    );
    expect(r.stderr).not.toContain('WHY THIS RULE EXISTS:');
    expect(r.stderr).toContain('WHAT WE FOUND:');
    expect(r.stderr).toContain('HOW TO FIX:');
    expect(r.stderr).toContain('Spec: specs/x.md');
    expect(r.stderr).toContain('Authored by platform-team · enforced since 2024-Q1.');
  });

  it('omits HOW block when fix_suggestion is absent', () => {
    const r = renderVerdict(
      {
        verdict: 'block',
        violations: [{ ...fullViolation, fix_suggestion: null }],
      },
      { hook: 'PreToolUse', ruleNames },
    );
    expect(r.stderr).not.toContain('HOW TO FIX:');
    expect(r.stderr).toContain('WHY THIS RULE EXISTS:');
    expect(r.stderr).toContain('WHAT WE FOUND:');
  });

  it('omits footer line when authored_by and enforced_since are both absent', () => {
    const r = renderVerdict(
      {
        verdict: 'block',
        violations: [
          {
            ...fullViolation,
            foundation: {
              spec: 'specs/x.md',
              rationale: 'r',
              authored_by: null,
              enforced_since: null,
            },
          },
        ],
      },
      { hook: 'PreToolUse', ruleNames },
    );
    expect(r.stderr).toContain('Spec: specs/x.md');
    expect(r.stderr).not.toContain('Authored by');
    expect(r.stderr).not.toContain('enforced since');
  });

  it('multi-violation: each violation gets its own internal layout, separated cleanly', () => {
    const r = renderVerdict(
      {
        verdict: 'block',
        violations: [
          fullViolation,
          {
            rule_id: 'AXT-JAVA-201',
            severity: 'blocking',
            message: 'Controller depends on `OrderRepository` directly.',
            foundation: {
              spec: 'specs/layering.md#controller-service-repository',
              rationale: 'Layer discipline post-incident control.',
              authored_by: 'platform-team',
              enforced_since: '2024-Q1',
            },
            fix_suggestion: 'Introduce a Service.',
          },
        ],
      },
      { hook: 'PreToolUse', ruleNames },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('AXT-JAVA-042 — Money values must use BigDecimal');
    expect(r.stderr).toContain('AXT-JAVA-201 — Controller must not depend on Repository directly');
    // Both violations carry the new internal layout.
    // `r.stderr` is `string | undefined` since 11.5.2 widened
    // `RenderedVerdict` to `HookEmission`; the .toContain assertions
    // above will have thrown if it were undefined, so coerce here.
    const stderr = r.stderr ?? '';
    const occurrencesOfWhy = stderr.split('WHY THIS RULE EXISTS:').length - 1;
    const occurrencesOfWhat = stderr.split('WHAT WE FOUND:').length - 1;
    const occurrencesOfHow = stderr.split('HOW TO FIX:').length - 1;
    expect(occurrencesOfWhy).toBe(2);
    expect(occurrencesOfWhat).toBe(2);
    expect(occurrencesOfHow).toBe(2);
    // Single closing rule + single footer at the end.
    expect(r.stderr).toContain('Resolve and retry.');
  });
});

describe('renderVerdict — PostToolUse', () => {
  it('block → exit 2 (surfaces stderr to agent; edit already landed) + advisory stderr', () => {
    const r = renderVerdict(blockingResp, { hook: 'PostToolUse', ruleNames });
    // D-022 revised + Spike D verdict 2026-05-13: PostToolUse exit 0
    // routes stderr to debug log only; exit 2 surfaces it to the agent.
    // Tool already ran, so exit 2 here can't "block" anything; the
    // "blocking error" harness label is cosmetic and the agent reads
    // through it.
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Axtar (post-edit): blocking rule violated');
    expect(r.stderr).toContain('Address the violation(s) above before continuing.');
  });

  it('warn → exit 2 (surfaces stderr to agent transcript) + stderr', () => {
    const r = renderVerdict(
      {
        verdict: 'warn',
        violations: [
          {
            rule_id: 'AXT-JAVA-077',
            severity: 'warning',
            message: 'Use a logger instead.',
            foundation: null,
            fix_suggestion: null,
          },
        ],
      },
      { hook: 'PostToolUse', ruleNames },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Axtar advisory');
    expect(r.stderr).toContain('AXT-JAVA-077 — No System.out.println');
    expect(r.stderr).toContain('Note this and continue.');
  });
});
