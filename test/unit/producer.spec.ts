/**
 * The local packet producer, against **real git repositories** built in temp
 * dirs — no mocked git. The producer's whole job is to agree with git about
 * what changed, so a fake would test the fake.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  currentBranch,
  findRepoRoot,
  newFileHunk,
  producePacket,
  resolveBaseRef,
} from '../../src/shared/producer.js';

let repo: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Axtar Test',
  GIT_AUTHOR_EMAIL: 'test@axtar.dev',
  GIT_COMMITTER_NAME: 'Axtar Test',
  GIT_COMMITTER_EMAIL: 'test@axtar.dev',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
}

function write(path: string, content: string | Buffer): void {
  const absolute = join(repo, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function commit(message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repo on `main` with one commit — the starting point for every test below. */
function seedRepo(): void {
  git(repo, '-c', 'init.defaultBranch=main', 'init');
  // `git init -b` needs git ≥ 2.28; setting HEAD before the first commit does
  // not, and the default branch name is load-bearing for the ladder.
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write('src/app.ts', 'export const a = 1;\n');
  write('README.md', '# demo\n');
  commit('initial');
}

beforeEach(() => {
  // realpath-resolved: macOS hands out /var/… symlinks into /private/var/…, and
  // `git rev-parse --show-toplevel` answers with the real path.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-producer-')));
  seedRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('repo root discovery', () => {
  it('finds the work tree root from a subdirectory', async () => {
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });

    const found = await findRepoRoot(join(repo, 'apps', 'web'));

    expect(found).toEqual({ ok: true, value: repo });
  });

  it('reports not_a_repo outside a work tree', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-not-a-repo-')));
    try {
      const found = await findRepoRoot(outside);
      expect(found).toMatchObject({ ok: false, reason: 'not_a_repo' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('builds root-relative paths when produced from a subdirectory', async () => {
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    write('apps/web/page.ts', 'export const page = 1;\n');

    const produced = await producePacket({ cwd: join(repo, 'apps', 'web') });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.repoRoot).toBe(repo);
    expect(produced.value.files.map((f) => f.path)).toEqual(['apps/web/page.ts']);
  });
});

describe('the base-ref ladder', () => {
  it('prefers an explicit ref over anything it would have guessed', async () => {
    const first = git(repo, 'rev-parse', 'HEAD');
    write('src/app.ts', 'export const a = 2;\n');
    commit('second');

    const resolved = await resolveBaseRef(repo, first);

    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.value.sha).toBe(first);
    expect(resolved.value.label).toContain('explicit');
  });

  it('refuses an explicit ref this repo does not know', async () => {
    const resolved = await resolveBaseRef(repo, 'origin/does-not-exist');

    expect(resolved).toMatchObject({ ok: false, reason: 'unknown_base_ref' });
  });

  it("uses origin/HEAD's branch when the symbolic ref is set", async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', base);
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    git(repo, 'checkout', '-b', 'feat/x');
    write('src/app.ts', 'export const a = 2;\n');
    commit('work');

    const resolved = await resolveBaseRef(repo);

    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.value.sha).toBe(base);
    expect(resolved.value.label).toBe('merge-base of HEAD and origin/trunk');
  });

  it('falls back to origin/main when nothing set origin/HEAD', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    git(repo, 'checkout', '-b', 'feat/x');
    write('src/app.ts', 'export const a = 2;\n');
    commit('work');

    const resolved = await resolveBaseRef(repo);

    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.value.sha).toBe(base);
    expect(resolved.value.label).toBe('merge-base of HEAD and origin/main');
  });

  it('falls back to the local main in a repo with no remote at all', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'feat/x');
    write('src/app.ts', 'export const a = 2;\n');
    commit('work');

    const resolved = await resolveBaseRef(repo);

    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.value.sha).toBe(base);
    expect(resolved.value.label).toBe('merge-base of HEAD and main');
  });

  it('asks for an explicit base when no rung of the ladder resolves', async () => {
    git(repo, 'branch', '-m', 'main', 'trunk');

    const resolved = await resolveBaseRef(repo);

    expect(resolved).toMatchObject({ ok: false, reason: 'no_base_ref' });
    if (resolved.ok) throw new Error('expected a refusal');
    expect(resolved.detail).toContain('pass base_ref explicitly');
  });

  it('reports no_commits in a repo where HEAD is unborn', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-empty-')));
    try {
      git(empty, '-c', 'init.defaultBranch=main', 'init');
      expect(await resolveBaseRef(empty)).toMatchObject({ ok: false, reason: 'no_commits' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the packet', () => {
  it('includes uncommitted work — staged and unstaged alike', async () => {
    write('src/app.ts', 'export const a = 2;\n');
    write('src/staged.ts', 'export const staged = true;\n');
    git(repo, 'add', 'src/staged.ts');

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.diff).toContain('+export const a = 2;');
    expect(produced.value.diff).toContain('+export const staged = true;');
    expect(produced.value.files).toEqual([
      { path: 'src/app.ts', content: 'export const a = 2;\n' },
      { path: 'src/staged.ts', content: 'export const staged = true;\n' },
    ]);
  });

  it('includes untracked files whole and synthesises them into the diff', async () => {
    write('src/new.ts', 'export const fresh = 1;\n');

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.untracked).toEqual(['src/new.ts']);
    expect(produced.value.files).toEqual([
      { path: 'src/new.ts', content: 'export const fresh = 1;\n' },
    ]);
    expect(produced.value.diff).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(produced.value.diff).toContain('new file mode 100644');
    expect(produced.value.diff).toContain('@@ -0,0 +1,1 @@');
    expect(produced.value.diff).toContain('+export const fresh = 1;');
  });

  it('lists a file inside a brand-new untracked directory, not the directory', async () => {
    write('feature/one.ts', 'export const one = 1;\n');
    write('feature/two.ts', 'export const two = 2;\n');

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.files.map((f) => f.path)).toEqual(['feature/one.ts', 'feature/two.ts']);
  });

  it('leaves a deleted file in the diff and out of files[]', async () => {
    rmSync(join(repo, 'README.md'));

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.diff).toContain('--- a/README.md');
    expect(produced.value.files.map((f) => f.path)).not.toContain('README.md');
  });

  it('excludes binary files from files[] and names them', async () => {
    write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
    write('src/app.ts', 'export const a = 2;\n');

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.binarySkipped).toEqual(['assets/logo.png']);
    expect(produced.value.files.map((f) => f.path)).toEqual(['src/app.ts']);
    // Not synthesised either — a hunk of unreadable bytes helps nobody.
    expect(produced.value.diff).not.toContain('assets/logo.png');
  });

  it('excludes a tracked file that became binary', async () => {
    write('data/blob.bin', 'text for now\n');
    commit('add blob');
    write('data/blob.bin', Buffer.from([0x01, 0x00, 0x02, 0x00]));

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.binarySkipped).toEqual(['data/blob.bin']);
    expect(produced.value.files).toEqual([]);
    expect(produced.value.diff).toContain('data/blob.bin');
  });

  it('diffs against the resolved base sha and reports where it came from', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'feat/x');
    write('src/app.ts', 'export const a = 2;\n');
    commit('committed work');
    write('src/app.ts', 'export const a = 3;\n');

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.baseRef).toBe(base);
    expect(produced.value.baseRefLabel).toBe('merge-base of HEAD and main');
    expect(produced.value.branch).toBe('feat/x');
    // Committed and uncommitted work both measured from the base.
    expect(produced.value.diff).toContain('+export const a = 3;');
    expect(produced.value.files).toEqual([
      { path: 'src/app.ts', content: 'export const a = 3;\n' },
    ]);
  });

  it('produces an empty packet for a clean tree', async () => {
    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.diff).toBe('');
    expect(produced.value.files).toEqual([]);
  });

  it('reports the branch as null when HEAD is detached', async () => {
    git(repo, 'checkout', '--detach', 'HEAD');

    expect(await currentBranch(repo)).toBeNull();
  });

  it('handles paths with spaces (the -z parsing)', async () => {
    write('docs/a note.md', 'hello\n');

    const produced = await producePacket({ cwd: repo });

    if (!produced.ok) throw new Error(produced.detail);
    expect(produced.value.files).toEqual([{ path: 'docs/a note.md', content: 'hello\n' }]);
  });

  it('surfaces an unknown explicit base ref as a producer failure', async () => {
    const produced = await producePacket({ cwd: repo, baseRef: 'v9.9.9' });

    expect(produced).toMatchObject({ ok: false, reason: 'unknown_base_ref' });
  });
});

describe('newFileHunk', () => {
  it('emits a git-shaped new-file hunk', () => {
    expect(newFileHunk('a/b.ts', 'one\ntwo\n', false)).toBe(
      [
        'diff --git a/a/b.ts b/a/b.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/a/b.ts',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
        '',
      ].join('\n'),
    );
  });

  it('marks a missing trailing newline the way git does', () => {
    expect(newFileHunk('a.txt', 'one', false)).toContain('\\ No newline at end of file');
  });

  it('marks an executable mode', () => {
    expect(newFileHunk('run.sh', '#!/bin/sh\n', true)).toContain('new file mode 100755');
  });

  it('emits only the header for an empty file', () => {
    expect(newFileHunk('empty.txt', '', false)).toBe(
      'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n',
    );
  });
});
