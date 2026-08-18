import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindingInstructions,
  configPathIn,
  findConfigFile,
  loadRepoBinding,
  readProjectId,
  resolveRepoDir,
} from '../../src/shared/project/config.js';

let repoDir: string;

beforeEach(() => {
  // realpath-resolved: macOS hands out /var/… symlinks into /private/var/….
  repoDir = resolve(mkdtempSync(join(tmpdir(), 'axtar-repo-')));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function writeConfig(dir: string, text: string): string {
  mkdirSync(join(dir, '.axtar'), { recursive: true });
  const path = configPathIn(dir);
  writeFileSync(path, text, 'utf-8');
  return path;
}

describe('readProjectId', () => {
  it('takes the top-level project value', () => {
    expect(readProjectId('version: 1\nproject: prj_8f3a2c\n')).toBe('prj_8f3a2c');
  });

  it('strips quotes and inline comments', () => {
    expect(readProjectId('project: "prj_8f3a2c"   # issued by the portal\n')).toBe('prj_8f3a2c');
    expect(readProjectId("project: 'prj_8f3a2c'\n")).toBe('prj_8f3a2c');
    expect(readProjectId('project: prj_8f3a2c # the portal issued this\n')).toBe('prj_8f3a2c');
  });

  it('keeps a # that is part of the value', () => {
    expect(readProjectId('project: prj_a#b\n')).toBe('prj_a#b');
  });

  it('ignores a nested project key — only the document root binds', () => {
    const text = ['version: 1', 'knowledge:', '  docs:', '    - project: not-this', ''].join('\n');
    expect(readProjectId(text)).toBeNull();
  });

  it('ignores commented-out and lookalike keys', () => {
    expect(readProjectId('# project: prj_old\nversion: 1\n')).toBeNull();
    expect(readProjectId('project_id: prj_old\n')).toBeNull();
  });

  it('returns null for an empty value', () => {
    expect(readProjectId('project:\nversion: 1\n')).toBeNull();
    expect(readProjectId('project:    # TODO\n')).toBeNull();
  });

  it('handles CRLF line endings', () => {
    expect(readProjectId('version: 1\r\nproject: prj_8f3a2c\r\n')).toBe('prj_8f3a2c');
  });
});

describe('findConfigFile', () => {
  it('finds the config at the repo root from a nested working directory', () => {
    const path = writeConfig(repoDir, 'version: 1\nproject: prj_8f3a2c\n');
    const nested = join(repoDir, 'apps', 'web', 'src');
    mkdirSync(nested, { recursive: true });

    expect(findConfigFile(nested)).toBe(path);
  });

  it('returns null when nothing is bound anywhere above', () => {
    expect(findConfigFile(repoDir)).toBeNull();
  });
});

describe('loadRepoBinding', () => {
  it('resolves the binding from the committed config', () => {
    const path = writeConfig(repoDir, 'version: 1\nproject: prj_8f3a2c\n');

    const result = loadRepoBinding(repoDir);

    expect(result).toEqual({ ok: true, binding: { projectId: 'prj_8f3a2c', configPath: path } });
  });

  it('reports no_config when the repo is not governed', () => {
    const result = loadRepoBinding(repoDir);

    expect(result).toEqual({ ok: false, reason: 'no_config', searchedFrom: repoDir });
    if (result.ok) return;
    expect(bindingInstructions(result)).toContain('.axtar/config.yml');
  });

  it('reports no_project when the config binds to nothing', () => {
    const path = writeConfig(repoDir, 'version: 1\nknowledge:\n  docs: []\n');

    const result = loadRepoBinding(repoDir);

    expect(result).toEqual({ ok: false, reason: 'no_project', configPath: path });
    if (result.ok) return;
    expect(bindingInstructions(result)).toContain("'project:'");
  });
});

describe('resolveRepoDir', () => {
  it('prefers CLAUDE_PROJECT_DIR over the working directory', () => {
    expect(resolveRepoDir({ CLAUDE_PROJECT_DIR: repoDir })).toBe(repoDir);
  });

  it('falls back to the working directory when unset or blank', () => {
    expect(resolveRepoDir({})).toBe(process.cwd());
    expect(resolveRepoDir({ CLAUDE_PROJECT_DIR: '  ' })).toBe(process.cwd());
  });
});
