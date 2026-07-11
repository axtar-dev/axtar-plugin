/**
 * v1 PostToolUse drift advisory (I1) — pure function.
 *
 * The advisory is a RULE-SCOPED REMINDER, not a drift verdict. These tests pin
 * both the honest no-op cases (no consult / no rules → null) and the reminder
 * text, including the load-bearing v1/v2 boundary phrase. They also guard
 * against over-reach: the reminder must NOT claim to have compared the landed
 * content (no "drift detected" / "differs from" / "substance mismatch").
 */

import { describe, expect, it } from 'vitest';

import { driftAdvisory } from '../../src/shared/drift-advisory.js';

describe('driftAdvisory — honest no-op cases', () => {
  it('consultRequired:false → null (no advisory)', () => {
    expect(driftAdvisory(false, ['AXT-ARC-1'])).toBeNull();
  });

  it('consultRequired:true but no rules → null (no rules, no reminder)', () => {
    expect(driftAdvisory(true, [])).toBeNull();
  });
});

describe('driftAdvisory — reminder text', () => {
  const RULES = ['AXT-ARC-1', 'AXT-DES-2'];
  const advisory = driftAdvisory(true, RULES);

  it('returns a non-null string', () => {
    expect(advisory).not.toBeNull();
  });

  it('names each governing rule id', () => {
    for (const id of RULES) {
      expect(advisory).toContain(id);
    }
  });

  it('frames the reminder as governance + verification', () => {
    expect(advisory).toContain('governance');
    expect(advisory).toContain('Verify');
    expect(advisory).toContain('matches');
  });

  it('carries the literal v1/v2 deferral phrase', () => {
    expect(advisory).toContain('full substance-drift review lands in v2');
    expect(advisory).toContain('v1 rule-scoped reminder only');
  });

  it('does NOT over-reach: no claim of having compared the landed content', () => {
    // Guard against wording that would imply drift coverage we don't have.
    expect(advisory).not.toContain('drift detected');
    expect(advisory).not.toContain('differs from');
    expect(advisory).not.toContain('substance mismatch');
  });
});
