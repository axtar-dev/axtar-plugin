/**
 * The tree fingerprint, against **real git repositories** in temp dirs, and the
 * state file that remembers it.
 *
 * The fingerprint's whole job is to be the same number on both sides of a check
 * — the MCP server stamps it, the turn-end reminder compares against it — so
 * what is asserted here is stability (same tree, same hash) and sensitivity
 * (any change git can see, a different hash).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_STATE,
  defaultStateDir,
  markWorkTreeChecked,
  readState,
  readWorkTreeState,
  stateFilePath,
  workTreeStateHash,
  writeState,
} from '../../src/shared/tree-state.js';

let repo: string;
let stateDir: string;

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

function write(path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function seedRepo(): void {
  git(repo, '-c', 'init.defaultBranch=main', 'init');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write('src/app.ts', 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
}

beforeEach(() => {
  // realpath-resolved: macOS hands out /var/… symlinks into /private/var/….
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-tree-')));
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-state-')));
  seedRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('workTreeStateHash', () => {
  it('is stable across calls on an unchanged tree', async () => {
    const first = await workTreeStateHash(repo);
    const second = await workTreeStateHash(repo);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
  });

  it('reports a committed tree as clean', async () => {
    expect(await readWorkTreeState(repo)).toMatchObject({ dirty: false });
  });

  it('changes when a tracked file is modified', async () => {
    const clean = await workTreeStateHash(repo);

    write('src/app.ts', 'export const a = 2;\n');

    const dirty = await readWorkTreeState(repo);
    expect(dirty).toMatchObject({ dirty: true });
    expect(dirty?.hash).not.toEqual(clean);
  });

  it('changes when an untracked file appears', async () => {
    const clean = await workTreeStateHash(repo);

    write('src/new.ts', 'export const b = 2;\n');

    const dirty = await readWorkTreeState(repo);
    expect(dirty).toMatchObject({ dirty: true });
    expect(dirty?.hash).not.toEqual(clean);
  });

  it('changes when a modification is staged — not only when it is written', async () => {
    write('src/app.ts', 'export const a = 3;\n');
    const unstaged = await workTreeStateHash(repo);

    git(repo, 'add', '-A');

    // `git diff HEAD` is why: plain `git diff` goes blank once a change is
    // staged, which would read as "the tree went back to what was checked".
    expect(await workTreeStateHash(repo)).not.toEqual(unstaged);
  });

  it('returns to the checked hash when a change is reverted', async () => {
    const clean = await workTreeStateHash(repo);
    write('src/app.ts', 'export const a = 4;\n');
    expect(await workTreeStateHash(repo)).not.toEqual(clean);

    write('src/app.ts', 'export const a = 1;\n');

    expect(await workTreeStateHash(repo)).toEqual(clean);
  });

  it('is null outside a git work tree', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-not-a-repo-')));
    try {
      expect(await workTreeStateHash(outside)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('works in a repository with no commits yet', async () => {
    const unborn = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-unborn-')));
    try {
      git(unborn, 'init');
      writeFileSync(join(unborn, 'a.txt'), 'hello\n');

      expect(await readWorkTreeState(unborn)).toMatchObject({ dirty: true });
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });
});

describe('the state file', () => {
  it('lives outside the repository, under the state dir', () => {
    const path = stateFilePath(repo, stateDir);

    expect(path.startsWith(stateDir)).toBe(true);
    expect(path.includes(repo)).toBe(false);
    expect(path.endsWith('.json')).toBe(true);
  });

  it('defaults to ~/.axtar/state', () => {
    expect(defaultStateDir('/home/dev')).toEqual('/home/dev/.axtar/state');
  });

  it('reads as empty when nothing was ever written', () => {
    expect(readState(repo, stateDir)).toEqual(EMPTY_STATE);
  });

  it('round-trips a patch and leaves the other field alone', () => {
    writeState(repo, { last_checked_hash: 'aaa' }, stateDir);
    writeState(repo, { last_nudged_hash: 'bbb' }, stateDir);

    const state = readState(repo, stateDir);
    expect(state.last_checked_hash).toEqual('aaa');
    expect(state.last_nudged_hash).toEqual('bbb');
    expect(state.updated_at).not.toBeNull();
  });

  it('keeps two repositories apart', () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-tree-other-')));
    try {
      writeState(repo, { last_checked_hash: 'aaa' }, stateDir);

      expect(readState(other, stateDir)).toEqual(EMPTY_STATE);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reads a corrupt file as nothing known, rather than throwing', () => {
    const path = stateFilePath(repo, stateDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, '{ this is not json');

    expect(readState(repo, stateDir)).toEqual(EMPTY_STATE);
  });

  it('never throws when the state dir cannot be written', () => {
    expect(() =>
      writeState(repo, { last_checked_hash: 'aaa' }, '/proc/axtar-cannot-write-here'),
    ).not.toThrow();
  });
});

describe('markWorkTreeChecked', () => {
  it('stamps the current tree state and nothing else', async () => {
    write('src/app.ts', 'export const a = 9;\n');

    await markWorkTreeChecked(repo, stateDir);

    const state = readState(repo, stateDir);
    expect(state.last_checked_hash).toEqual(await workTreeStateHash(repo));
    expect(state.last_nudged_hash).toBeNull();
    expect(JSON.parse(readFileSync(stateFilePath(repo, stateDir), 'utf-8'))).toMatchObject({
      last_checked_hash: state.last_checked_hash,
    });
  });

  it('writes nothing outside a work tree', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-not-a-repo-')));
    try {
      await markWorkTreeChecked(outside, stateDir);

      expect(readState(outside, stateDir)).toEqual(EMPTY_STATE);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
