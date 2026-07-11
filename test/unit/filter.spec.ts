import { describe, expect, it } from 'vitest';

import {
  filterRules,
  globToRegex,
  languageForPath,
  matchesAnyGlob,
} from '../../src/shared/rules/filter.js';
import { HIGH_ALTITUDES } from '../../src/shared/payload-types.js';
import type { RuleSummary } from '../../src/shared/wire/schemas.js';

describe('globToRegex', () => {
  // These cases mirror engine/tests/test_glob_match.py — the engine and the
  // plugin implement the same gitignore-glob semantics independently. Drift
  // between them is a silent correctness bug. Keep both tables in sync; a
  // case added on either side MUST be added on the other.
  // Follow-up: extract to a shared JSON fixture (Phase 6+).
  const cases: ReadonlyArray<{ pattern: string; path: string; expected: boolean }> = [
    { pattern: '**/domain/**/*.java', path: 'src/main/java/domain/Order.java', expected: true },
    { pattern: '**/domain/**/*.java', path: 'src/main/java/domain/sub/Order.java', expected: true },
    { pattern: '**/domain/**/*.java', path: 'src/main/java/api/Order.java', expected: false },
    { pattern: '**/domain/**/*.java', path: 'domain/Order.java', expected: true },
    { pattern: '**/*.java', path: 'X.java', expected: true },
    { pattern: '*.java', path: 'X.java', expected: true },
    { pattern: '*.java', path: 'sub/X.java', expected: false },
    { pattern: '**/Order?.java', path: 'src/Order1.java', expected: true },
    { pattern: '**/Order?.java', path: 'src/Order12.java', expected: false },
    { pattern: 'src/**', path: 'src/main/X.java', expected: true },
    { pattern: 'src/**', path: 'src/', expected: true },
  ];
  for (const { pattern, path, expected } of cases) {
    it(`${pattern} matches ${path} → ${expected}`, () => {
      expect(globToRegex(pattern).test(path)).toBe(expected);
    });
  }
});

describe('matchesAnyGlob', () => {
  it('returns true on empty globs (no path restriction)', () => {
    expect(matchesAnyGlob('a/b/c.java', [])).toBe(true);
  });
  it('returns true if any glob matches', () => {
    expect(
      matchesAnyGlob('src/service/PaymentService.java', [
        '**/domain/**/*.java',
        '**/service/**/*.java',
      ]),
    ).toBe(true);
  });
});

describe('languageForPath', () => {
  it('maps .java', () => {
    expect(languageForPath('a/b/Order.java')).toBe('java');
  });
  it('returns undefined for unknown extensions', () => {
    expect(languageForPath('a/b/Order.kt')).toBeUndefined();
  });
});

describe('filterRules', () => {
  // Single-engine product (D-046): every rule is `llm`. The former per-engine
  // partition dimension was removed (D-049); filterRules now gates on severity
  // + language/path applicability, with the high-altitude gate carve-out.
  const rules: RuleSummary[] = [
    {
      id: 'AXT-JAVA-042',
      name: 'money',
      altitude: 'implementation',
      severity: 'blocking',
      language: 'java',
      paths: ['**/domain/**/*.java'],
    },
    {
      id: 'AXT-JAVA-077',
      name: 'no println',
      altitude: 'convention',
      severity: 'warning',
      language: 'java',
      paths: [],
    },
    {
      id: 'AXT-JAVA-118',
      name: 'autowired',
      altitude: 'design',
      severity: 'blocking',
      language: 'java',
      paths: ['**/*.java'],
    },
  ];

  it('PreToolUse-style filter (blocking only) on a domain file', () => {
    const out = filterRules(rules, 'src/main/java/domain/Order.java', {
      severities: new Set(['blocking']),
    });
    expect(out.map((r) => r.id).sort()).toEqual(['AXT-JAVA-042', 'AXT-JAVA-118']);
  });

  it('PostToolUse-style filter (warning + suggestion) on the same file', () => {
    const out = filterRules(rules, 'src/main/java/domain/Order.java', {
      severities: new Set(['warning', 'suggestion']),
    });
    expect(out.map((r) => r.id)).toEqual(['AXT-JAVA-077']);
  });

  it('drops rules whose paths do not match', () => {
    const out = filterRules(rules, 'src/main/java/api/OrderApi.java', {
      severities: new Set(['blocking']),
    });
    expect(out.map((r) => r.id)).toEqual(['AXT-JAVA-118']);
  });

  it('drops rules whose language does not match', () => {
    const out = filterRules(rules, 'src/main/kotlin/Order.kt', {
      severities: new Set(['blocking']),
    });
    expect(out).toEqual([]);
  });

  it('skips language filter for unknown extensions (server re-filters by applicability)', () => {
    // Rule with no path restriction AND blocking severity, so only the
    // language filter could exclude it. With an unknown extension we don't
    // run the language filter, so the rule stays in.
    const noPathBlocking: RuleSummary = {
      id: 'AXT-JAVA-999',
      name: 'fence',
      altitude: 'convention',
      severity: 'blocking',
      language: 'java',
      paths: [],
    };
    const out = filterRules([noPathBlocking], 'README', {
      severities: new Set(['blocking']),
    });
    expect(out.map((r) => r.id)).toEqual(['AXT-JAVA-999']);
  });
});

describe('filterRules — high-altitude gate carve-out (Pre Mentor gate, v1 bug fix)', () => {
  // The real walkthrough rule shape: high-altitude + warning severity. On the
  // Pre path the severity filter is {blocking}, which would drop this rule — so
  // the Mentor gate never fired for it (the v1 bug). The gate trigger is
  // altitude-only (the server computes consult_required from applicability,
  // independent of severity), so high-altitude rules must survive the Pre
  // severity filter to reach /evaluate. Their LLM *detection* still stays
  // Post-only (server defers it on the gate-check call).
  //
  // Single-engine product (D-049): the former engine-partition dimension was
  // removed, so this carve-out is now the SOLE Pre-path gate-forwarding
  // mechanism. These cases are the regression guard for that guarantee.
  const highAltLlmWarning: RuleSummary = {
    id: 'AXT-ARC-001',
    name: 'architect approval',
    altitude: 'architectural',
    severity: 'warning',
    language: 'java',
    paths: ['**/*.java'],
  };
  const lowAltLlmWarning: RuleSummary = {
    id: 'AXT-IMP-001',
    name: 'impl llm',
    altitude: 'implementation',
    severity: 'warning',
    language: 'java',
    paths: ['**/*.java'],
  };

  it('high-altitude rule survives the Pre filter despite severity mismatch', () => {
    const out = filterRules([highAltLlmWarning], 'src/Foo.java', {
      severities: new Set(['blocking']),
      gateAltitudes: HIGH_ALTITUDES,
    });
    expect(out.map((r) => r.id)).toEqual(['AXT-ARC-001']);
  });

  it('high-altitude BLOCKING rule also survives via the carve-out', () => {
    // The carve-out short-circuits BEFORE the severity check, so a high-altitude
    // rule survives at any severity (this pins the blocking case too).
    const highAltLlmBlocking: RuleSummary = {
      ...highAltLlmWarning,
      id: 'AXT-ARC-002',
      severity: 'blocking',
    };
    const out = filterRules([highAltLlmBlocking], 'src/Foo.java', {
      severities: new Set(['blocking']),
      gateAltitudes: HIGH_ALTITUDES,
    });
    expect(out.map((r) => r.id)).toEqual(['AXT-ARC-002']);
  });

  it('low-altitude rule below the severity threshold is still dropped (carve-out is altitude-scoped)', () => {
    const out = filterRules([lowAltLlmWarning], 'src/Foo.java', {
      severities: new Set(['blocking']),
      gateAltitudes: HIGH_ALTITUDES,
    });
    expect(out).toEqual([]);
  });

  it('gate rule still must pass path applicability (not blanket-kept)', () => {
    const serviceScoped: RuleSummary = {
      ...highAltLlmWarning,
      paths: ['**/service/**/*.java'],
    };
    const out = filterRules([serviceScoped], 'src/web/Foo.java', {
      severities: new Set(['blocking']),
      gateAltitudes: HIGH_ALTITUDES,
    });
    expect(out).toEqual([]);
  });

  it('omitting gateAltitudes applies the normal severity gate (Post path unchanged)', () => {
    const out = filterRules([highAltLlmWarning], 'src/Foo.java', {
      severities: new Set(['blocking']),
    });
    expect(out).toEqual([]);
  });
});
