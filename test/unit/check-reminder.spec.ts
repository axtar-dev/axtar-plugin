/**
 * The turn-end reminder's decision ladder.
 *
 * The property that matters is not "does it remind" but **"can it ever nag"**:
 * a Stop hook that blocks runs again when the agent stops again, so every test
 * here is really asking whether some second run stays silent. The state file is
 * real (a temp dir); git and the binding are seams, because what is under test
 * is the ladder, not git — `tree-state.spec.ts` puts the fingerprint against a
 * real repository.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OFF_SWITCH_ENV,
  REMINDER_TEXT,
  blockOutput,
  decide,
  parseInput,
} from '../../src/hooks/check-reminder.js';
import type { ReminderDeps, StopHookInput } from '../../src/hooks/check-reminder.js';
import { loadRepoBinding } from '../../src/shared/project/config.js';
import { readState, writeState } from '../../src/shared/tree-state.js';
import type { WorkTreeState } from '../../src/shared/tree-state.js';

const DIRTY = 'a1b2c3-dirty-tree';

let repoDir: string;
let stateDir: string;

function writeConfig(): void {
  mkdirSync(join(repoDir, '.axtar'), { recursive: true });
  writeFileSync(
    join(repoDir, '.axtar', 'config.yml'),
    'version: 1\nproject: 3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55\n',
  );
}

function deps(over: Partial<ReminderDeps> = {}): ReminderDeps {
  return {
    env: {},
    cwd: repoDir,
    stateDir,
    findRoot: async () => ({ ok: true, value: repoDir }),
    readTree: async (): Promise<WorkTreeState | null> => ({ hash: DIRTY, dirty: true }),
    loadBinding: loadRepoBinding,
    ...over,
  };
}

const STOP: StopHookInput = {
  session_id: 's-1',
  transcript_path: '/tmp/transcript.jsonl',
  hook_event_name: 'Stop',
  stop_hook_active: false,
};

beforeEach(() => {
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-reminder-')));
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-reminder-state-')));
  writeConfig();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('the allow paths — the turn ends and nothing is said', () => {
  it('allows when the repo has no .axtar/config.yml (a)', async () => {
    rmSync(join(repoDir, '.axtar'), { recursive: true, force: true });

    expect(await decide(STOP, deps())).toEqual({ kind: 'allow', reason: 'not_bound' });
  });

  it('allows when the tree is clean (b)', async () => {
    const decision = await decide(
      STOP,
      deps({ readTree: async () => ({ hash: 'clean-tree', dirty: false }) }),
    );

    expect(decision).toEqual({ kind: 'allow', reason: 'tree_clean' });
  });

  it('allows when this exact tree state was already checked (c)', async () => {
    writeState(repoDir, { last_checked_hash: DIRTY }, stateDir);

    expect(await decide(STOP, deps())).toEqual({ kind: 'allow', reason: 'already_checked' });
  });

  it('allows when this exact tree state was already nudged (d)', async () => {
    writeState(repoDir, { last_nudged_hash: DIRTY }, stateDir);

    expect(await decide(STOP, deps())).toEqual({ kind: 'allow', reason: 'already_nudged' });
  });

  it('allows when a Stop hook already continued this turn (e)', async () => {
    const decision = await decide({ ...STOP, stop_hook_active: true }, deps());

    expect(decision).toEqual({ kind: 'allow', reason: 'stop_hook_active' });
  });

  it(`allows when ${OFF_SWITCH_ENV} is set (f)`, async () => {
    const decision = await decide(STOP, deps({ env: { [OFF_SWITCH_ENV]: '1' } }));

    expect(decision).toEqual({ kind: 'allow', reason: 'off_switch' });
  });

  it('ignores an empty off switch — an unset-looking value is unset', async () => {
    const decision = await decide(STOP, deps({ env: { [OFF_SWITCH_ENV]: '  ' } }));

    expect(decision.kind).toEqual('nudge');
  });

  it('allows outside a git work tree', async () => {
    const decision = await decide(
      STOP,
      deps({ findRoot: async () => ({ ok: false, reason: 'not_a_repo', detail: 'no git' }) }),
    );

    expect(decision).toEqual({ kind: 'allow', reason: 'not_a_repo' });
  });

  it('allows when the tree state cannot be read at all', async () => {
    const decision = await decide(STOP, deps({ readTree: async () => null }));

    expect(decision).toEqual({ kind: 'allow', reason: 'tree_unreadable' });
  });

  it('writes nothing on an allow', async () => {
    await decide(STOP, deps({ readTree: async () => ({ hash: 'clean-tree', dirty: false }) }));

    expect(readState(repoDir, stateDir).last_nudged_hash).toBeNull();
  });
});

describe('the nudge — once per unchecked tree state, and only once', () => {
  it('asks for axtar_check_diff, the receipt, and says it fires once', async () => {
    const decision = await decide(STOP, deps());

    expect(decision).toEqual({ kind: 'nudge', reason: REMINDER_TEXT });
    expect(REMINDER_TEXT).toContain('axtar_check_diff');
    expect(REMINDER_TEXT).toContain('receipt block');
    expect(REMINDER_TEXT).toContain('only once per unchecked change');
  });

  it('records the state it nudged for', async () => {
    await decide(STOP, deps());

    expect(readState(repoDir, stateDir).last_nudged_hash).toEqual(DIRTY);
  });

  it('stays silent on a second stop with the tree unchanged', async () => {
    const first = await decide(STOP, deps());
    const second = await decide(STOP, deps());

    expect(first.kind).toEqual('nudge');
    expect(second).toEqual({ kind: 'allow', reason: 'already_nudged' });
  });

  it('re-arms when the tree changes again after a nudge', async () => {
    await decide(STOP, deps());

    const later = await decide(
      STOP,
      deps({ readTree: async () => ({ hash: 'a-different-tree', dirty: true }) }),
    );

    expect(later).toEqual({ kind: 'nudge', reason: REMINDER_TEXT });
    expect(readState(repoDir, stateDir).last_nudged_hash).toEqual('a-different-tree');
  });

  it('goes quiet once the check runs and marks that same state', async () => {
    await decide(STOP, deps());
    // What a successful axtar_check_diff leaves behind.
    writeState(repoDir, { last_checked_hash: DIRTY }, stateDir);

    expect(await decide(STOP, deps())).toEqual({ kind: 'allow', reason: 'already_checked' });
  });

  it('emits Claude Code’s block decision, and only that', () => {
    expect(blockOutput(REMINDER_TEXT)).toEqual({ decision: 'block', reason: REMINDER_TEXT });
    expect(Object.keys(blockOutput('x'))).toEqual(['decision', 'reason']);
  });

  it('uses the cwd the payload names, not the process one', async () => {
    let asked = '';
    await decide(
      { ...STOP, cwd: '/some/other/place' },
      deps({
        findRoot: async (cwd) => {
          asked = cwd;
          return { ok: true, value: repoDir };
        },
      }),
    );

    expect(asked).toEqual('/some/other/place');
  });
});

describe('the stdin payload', () => {
  it('reads the fields Claude Code sends', () => {
    const parsed = parseInput(
      JSON.stringify({
        session_id: 's-9',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/repo',
        hook_event_name: 'Stop',
        stop_hook_active: true,
        something_new: 42,
      }),
    );

    expect(parsed).toEqual({
      session_id: 's-9',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      stop_hook_active: true,
    });
  });

  it('reads garbage as an empty payload rather than throwing', () => {
    expect(parseInput('')).toEqual({});
    expect(parseInput('not json')).toEqual({});
    expect(parseInput('null')).toEqual({});
    expect(parseInput('{"stop_hook_active":"yes"}')).toEqual({});
  });
});
