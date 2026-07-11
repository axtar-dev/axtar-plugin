import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyEdit, applyWrite } from '../../src/shared/edit/apply.js';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'axtar-apply-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeFile(name: string, contents: string): string {
  const p = join(workDir, name);
  writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('applyEdit', () => {
  it('returns ok with substituted file_after for a unique match', () => {
    const fp = writeFile('a.java', 'class A { int x = 0; }\n');
    const out = applyEdit({ file_path: fp, old_string: 'int x = 0;', new_string: 'int x = 1;' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.file_after).toBe('class A { int x = 1; }\n');
    }
  });

  it('returns ambiguous_old_string on multiple matches without replace_all', () => {
    const fp = writeFile('b.java', 'int x = 0;\nint x = 0;\n');
    const out = applyEdit({ file_path: fp, old_string: 'int x = 0;', new_string: 'int x = 1;' });
    expect(out.kind).toBe('ambiguous_old_string');
  });

  it('returns ok with all replaced when replace_all=true', () => {
    const fp = writeFile('c.java', 'int x = 0;\nint x = 0;\n');
    const out = applyEdit({
      file_path: fp,
      old_string: 'int x = 0;',
      new_string: 'int x = 1;',
      replace_all: true,
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.file_after).toBe('int x = 1;\nint x = 1;\n');
    }
  });

  it('returns old_string_not_found when old_string is absent', () => {
    const fp = writeFile('d.java', 'class D {}\n');
    const out = applyEdit({ file_path: fp, old_string: 'foo', new_string: 'bar' });
    expect(out.kind).toBe('old_string_not_found');
  });

  it('returns file_not_found for missing files', () => {
    const out = applyEdit({
      file_path: join(workDir, 'does-not-exist.java'),
      old_string: 'a',
      new_string: 'b',
    });
    expect(out.kind).toBe('file_not_found');
  });
});

describe('applyWrite', () => {
  it('returns ok with file_after = content for an existing file', () => {
    const fp = writeFile('w.java', 'old\n');
    const out = applyWrite({ file_path: fp, content: 'new\n' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.file_before).toBe('old\n');
      expect(out.file_after).toBe('new\n');
    }
  });

  it('returns ok with empty file_before for new files', () => {
    const out = applyWrite({
      file_path: join(workDir, 'newfile.java'),
      content: 'class N {}\n',
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.file_before).toBe('');
      expect(out.file_after).toBe('class N {}\n');
    }
  });
});
