/**
 * PostToolUse hook entry-point wiring tests (Step 10.4). Same shape as
 * pre-tool-use.spec.ts; see that file for the rationale. The empty
 * rule_set short-circuit is tested in runner.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('post-tool-use hook → wrapper wiring', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('../../src/shared/runner.js');
    vi.doUnmock('node:fs');
  });

  it('passes assembleForPost and the warning+suggestion severity set to run()', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const readStdinMock = vi.fn().mockResolvedValue('{}');

    vi.doMock('../../src/shared/runner.js', () => ({
      run: runMock,
      readStdin: readStdinMock,
    }));
    vi.doMock('node:fs', () => ({ appendFileSync: vi.fn() }));

    const assembleMod = await import('../../src/hosts/claude-code/assemble.js');
    await import('../../src/hosts/claude-code/entrypoints/post.js');
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
    expect(options.hook).toBe('PostToolUse');
    expect(options.assemble).toBe(assembleMod.assembleForPost);
    expect(options.assemble).not.toBe(assembleMod.assembleForPre);
    expect([...options.severities].sort()).toEqual(['suggestion', 'warning']);
    expect(options.consultLoopAvailable).toBe(true);
  });
});
