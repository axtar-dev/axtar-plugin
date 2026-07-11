/**
 * PreToolUse hook entry-point wiring tests (Step 10.4).
 *
 * The hook file itself is very thin — it picks the right `assembleFor*`
 * wrapper + severity set and delegates to `run`. This spec verifies that
 * `pre-tool-use.ts` passes `assembleForPre` (not `assembleForPost`) and
 * the blocking-severity set into `run`.
 *
 * The empty-rule-set short-circuit is exercised in `runner.spec.ts` —
 * that's the layer where the short-circuit logic lives.
 *
 * The hook has top-level side effects (a tracer `appendFileSync` and a
 * fire-and-forget `main().catch(...)`), so the spec mocks `node:fs` and
 * the runner before dynamic-importing the hook module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('pre-tool-use hook → wrapper wiring', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('../../src/shared/runner.js');
    vi.doUnmock('node:fs');
  });

  it('passes assembleForPre and the blocking-severity set to run()', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const readStdinMock = vi.fn().mockResolvedValue('{}');

    vi.doMock('../../src/shared/runner.js', () => ({
      run: runMock,
      readStdin: readStdinMock,
    }));
    vi.doMock('node:fs', () => ({ appendFileSync: vi.fn() }));

    const assembleMod = await import('../../src/hosts/claude-code/assemble.js');
    await import('../../src/hosts/claude-code/entrypoints/pre.js');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runMock).toHaveBeenCalledOnce();
    const args = runMock.mock.calls[0];
    expect(args).toBeDefined();
    const options = args![1] as {
      hook: string;
      severities: ReadonlySet<string>;
      assemble: unknown;
      consultLoopAvailable: boolean;
    };
    expect(options.hook).toBe('PreToolUse');
    expect(options.assemble).toBe(assembleMod.assembleForPre);
    expect(options.assemble).not.toBe(assembleMod.assembleForPost);
    expect([...options.severities].sort()).toEqual(['blocking']);
    expect(options.consultLoopAvailable).toBe(true);
  });
});
