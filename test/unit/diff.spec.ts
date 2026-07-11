import { describe, expect, it } from 'vitest';

import { unifiedDiff } from '../../src/shared/edit/diff.js';

describe('unifiedDiff', () => {
  it('returns empty string when before === after', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'x')).toBe('');
  });

  it('emits headers and a hunk for a single-line change', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.java', 'x.java');
    expect(diff).toContain('--- a/x.java');
    expect(diff).toContain('+++ b/x.java');
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
    expect(diff).toContain(' a');
    expect(diff).toContain(' c');
  });

  it('handles inserts at end of file', () => {
    const diff = unifiedDiff('a\n', 'a\nb\n', 'x', 'x');
    expect(diff).toContain('+b');
  });

  it('handles deletes', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nc\n', 'x', 'x');
    expect(diff).toContain('-b');
  });
});
