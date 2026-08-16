/**
 * The wire contract, pinned.
 *
 * `test/fixtures/wire/*.json` are hand-copied response bodies in the shape
 * `api/app/schemas/plugin/check.py` declares in the platform repo. **They must
 * track that file**: when the platform's `DiffCheckResponse` / `SpecCheckResponse`
 * (or the `FindingOut` / `MustStateOut` / `ConflictOut` / `UnaddressedOut` /
 * `DroppedRuleOut` members) gain, lose or rename a field, update the fixtures
 * and the zod schemas in the same change — a green test here against a stale
 * fixture is exactly the silent skew this file exists to prevent.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DiffCheckRequestSchema,
  SpecCheckRequestSchema,
  parseDiffCheckResponse,
  parseSpecCheckResponse,
  salvageReceipt,
} from '../../src/shared/wire/checks.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'wire');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8')) as Record<string, unknown>;
}

describe('diff check response', () => {
  it('round-trips the platform shape', () => {
    const parsed = parseDiffCheckResponse(fixture('diff-response.json'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the fixture to parse');
    expect(parsed.value.verdict).toBe('breaches');
    expect(parsed.value.considered).toBe(212);
    expect(parsed.value.checked).toBe(209);
    expect(parsed.value.dropped).toEqual([
      { rule_id: 'AXT-0003', reason: 'packet_cap' },
      { rule_id: 'AXT-0004', reason: 'timeout' },
      { rule_id: 'AXT-0005', reason: 'provider_error' },
    ]);
    expect(parsed.value.receipt).toContain('212 considered');

    const breach = parsed.value.breaches[0];
    expect(breach?.rule_id).toBe('AXT-0001');
    expect(breach?.rule_version).toBe(1);
    expect(breach?.defended).toBe(true);
    expect(breach?.source).toMatchObject({ kind: 'stated', ref: 'docs/refunds.md' });
  });

  it('accepts the nulls the platform really sends', () => {
    const parsed = parseDiffCheckResponse(fixture('diff-response.json'));
    if (!parsed.ok) throw new Error('expected the fixture to parse');

    const advisory = parsed.value.advisories[0];
    expect(advisory?.line).toBeNull();
    expect(advisory?.evidence_quote).toBeNull();
    expect(advisory?.source).toBeNull();
    expect(advisory?.cache_sourced).toBe(true);
  });

  it('ignores a field the platform added — an addition must not hide a judgment', () => {
    const body = { ...fixture('diff-response.json'), escape_rate: 0.02 };

    const parsed = parseDiffCheckResponse(body);

    expect(parsed.ok).toBe(true);
  });

  it('reports drift, with the raw body, when a field is renamed away', () => {
    const body = fixture('diff-response.json');
    delete body['receipt'];
    body['summary_line'] = 'renamed by the platform';

    const parsed = parseDiffCheckResponse(body);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected drift');
    expect(parsed.issues.join('\n')).toContain('receipt');
    expect(parsed.raw).toBe(body);
  });

  it('reports drift on a type change inside a finding', () => {
    const body = fixture('diff-response.json');
    (body['breaches'] as Record<string, unknown>[])[0]!['rule_version'] = '1';

    const parsed = parseDiffCheckResponse(body);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected drift');
    expect(parsed.issues.join('\n')).toContain('breaches.0.rule_version');
  });

  it('never throws on a body that is not an object at all', () => {
    expect(parseDiffCheckResponse('<html>gateway</html>').ok).toBe(false);
    expect(parseDiffCheckResponse(null).ok).toBe(false);
  });
});

describe('spec check response', () => {
  it('round-trips the platform shape', () => {
    const parsed = parseSpecCheckResponse(fixture('spec-response.json'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the fixture to parse');
    expect(parsed.value.verdict).toBe('needs_revision');
    expect(parsed.value.must_state[0]?.line_for_the_spec).toBe(
      'The refund amount must never exceed the original charge.',
    );
    expect(parsed.value.conflicts[0]?.where_in_spec).toBe('Errors are returned as bare strings.');
    expect(parsed.value.unaddressed[0]?.why).toBeNull();
    expect(parsed.value.open_questions).toEqual(['Which service owns the refund ledger entry?']);
    expect(parsed.value.dropped).toEqual([{ rule_id: 'AXT-0009', reason: 'timeout' }]);
  });

  it('reports drift when must_state loses its paste-ready line', () => {
    const body = fixture('spec-response.json');
    delete (body['must_state'] as Record<string, unknown>[])[0]!['line_for_the_spec'];

    const parsed = parseSpecCheckResponse(body);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected drift');
    expect(parsed.issues.join('\n')).toContain('must_state.0.line_for_the_spec');
  });
});

describe('requests', () => {
  it('accepts the packet the producer builds', () => {
    const parsed = DiffCheckRequestSchema.safeParse({
      project: '3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55',
      diff: 'diff --git a/a b/a\n',
      base_ref: 'a'.repeat(40),
      files: [{ path: 'a', content: 'x\n' }],
      ref: 'feat/refunds',
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a field the platform would 422 on (extra="forbid")', () => {
    const parsed = DiffCheckRequestSchema.safeParse({
      project: 'p',
      diff: '',
      base_ref: 'sha',
      files: [],
      repo: 'axtar/platform',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a file entry carrying anything but path and content', () => {
    const parsed = DiffCheckRequestSchema.safeParse({
      project: 'p',
      diff: '',
      base_ref: 'sha',
      files: [{ path: 'a', content: 'x', mode: '100644' }],
    });

    expect(parsed.success).toBe(false);
  });

  it('requires a spec on the spec call', () => {
    expect(SpecCheckRequestSchema.safeParse({ project: 'p', spec: '' }).success).toBe(false);
    expect(SpecCheckRequestSchema.safeParse({ project: 'p', spec: '# plan' }).success).toBe(true);
  });
});

describe('salvageReceipt', () => {
  it('rescues the §10 block out of a body that did not parse', () => {
    const body = { ...fixture('diff-response.json'), breaches: 'nope' };

    expect(salvageReceipt(body)).toEqual({
      check_id: '3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55',
      url: 'https://app.axtar.dev/checks/3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55',
      receipt: '212 considered · 209 checked · 3 dropped · 1 breaches · 1 advisories',
    });
  });

  it('returns null when there is no receipt to rescue', () => {
    expect(salvageReceipt({ detail: 'boom' })).toBeNull();
  });
});
