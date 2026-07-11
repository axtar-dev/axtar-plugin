/**
 * Runner short-circuit tests (Step 10.4).
 *
 * The runner is where empty-rule-set short-circuit lives. When the
 * caller-provided `assemble` wrapper produces a request with no rule_set
 * survivors, the runner must NOT call /evaluate — gratuitous adapter
 * invocation is a real production-cost issue, especially for the LLM
 * engine. This spec exercises that path with a real runner and mocked
 * fetch / process.exit.
 *
 * The Pre and Post variants share the runner, so this single spec covers
 * both hooks' short-circuit guarantees.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeCodeOutputAdapter } from '../../src/hosts/claude-code/adapter.js';
import {
  assembleForPre,
  assembleForPost,
  parseHookInput,
} from '../../src/hosts/claude-code/assemble.js';
import { run } from '../../src/shared/runner.js';
import type { RuleSummary } from '../../src/shared/wire/schemas.js';

const ENGINE_URL = 'http://127.0.0.1:9999';

function rulesResponse(rules: RuleSummary[]): Response {
  return new Response(JSON.stringify(rules), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function evaluateRefusal(): Response {
  // If /evaluate is hit by accident, return 500 so the test can also detect
  // it via failed-response paths — but the primary check is fetch URL.
  return new Response('must not be reached', { status: 500 });
}

describe('runner — empty rule_set short-circuit', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let prevBaseUrl: string | undefined;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // `process.exit` throws a sentinel so the runner's `never`-returning
    // exit path actually terminates control flow (otherwise it falls through
    // to /evaluate). The test awaits .rejects.toThrow to capture this.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__test_exit__');
    }) as never);

    prevBaseUrl = process.env.AXTAR_ENGINE_URL;
    process.env.AXTAR_ENGINE_URL = ENGINE_URL;
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    if (prevBaseUrl === undefined) delete process.env.AXTAR_ENGINE_URL;
    else process.env.AXTAR_ENGINE_URL = prevBaseUrl;
  });

  // Single-engine product (D-046/D-049): the empty-rule_set short-circuit no
  // longer depends on an engine partition — every rule is `llm`. These two
  // cases exercise the same guarantee through the surviving filters: a rule
  // dropped by severity (Pre) or by path applicability (Post) leaves rule_set
  // empty, and the runner must NOT call /evaluate.
  it('PreToolUse: skips /evaluate when the pre-filter drops every rule (severity)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'axtar-runner-pre-'));
    const fp = join(dir, 'probe.txt');
    writeFileSync(fp, 'a');
    // A low-altitude `warning` rule under the Pre severity set {blocking}: not
    // high-altitude (no gate carve-out) and below the severity threshold, so it
    // is filtered out → rule_set empty.
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) {
        return Promise.resolve(
          rulesResponse([
            {
              id: 'AXT-IMP-001',
              name: 'impl warning',
              altitude: 'implementation',
              severity: 'warning',
              language: 'java',
              paths: [],
            },
          ]),
        );
      }
      return Promise.resolve(evaluateRefusal());
    });

    const stdin = JSON.stringify({
      session_id: 's',
      tool_name: 'Edit',
      tool_input: { file_path: fp, old_string: 'a', new_string: 'b' },
    });

    await expect(
      run(stdin, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((u) => u.endsWith('/rules'))).toBe(true);
    expect(calledUrls.some((u) => u.endsWith('/evaluate'))).toBe(false);
  });

  it('PostToolUse: skips /evaluate when the pre-filter drops every rule (path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'axtar-runner-post-'));
    const fp = join(dir, 'probe.txt');
    writeFileSync(fp, 'a');
    // A rule scoped to **/*.java does not apply to a .txt edit → filtered out →
    // rule_set empty.
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) {
        return Promise.resolve(
          rulesResponse([
            {
              id: 'AXT-IMP-002',
              name: 'java only',
              altitude: 'implementation',
              severity: 'warning',
              language: 'java',
              paths: ['**/*.java'],
            },
          ]),
        );
      }
      return Promise.resolve(evaluateRefusal());
    });

    const stdin = JSON.stringify({
      session_id: 's',
      tool_name: 'Edit',
      tool_input: { file_path: fp, old_string: 'a', new_string: 'b' },
    });

    await expect(
      run(stdin, {
        hook: 'PostToolUse',
        severities: new Set(['warning', 'suggestion']),
        parseInput: parseHookInput,
        assemble: assembleForPost,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((u) => u.endsWith('/rules'))).toBe(true);
    expect(calledUrls.some((u) => u.endsWith('/evaluate'))).toBe(false);
  });
});

/**
 * Runner emit → process.stdout coverage (11.5.4 follow-up).
 *
 * 11.5.2 widened `emit()` to write `process.stdout` when
 * `HookEmission.stdout` is set. The Claude Code adapter never sets it,
 * so the original regression check (verdict/assemble/runner specs)
 * proves only that the no-stdout path is unaffected — it doesn't
 * exercise the new write. This spec exercises it via an injected
 * OutputAdapter that returns `HookEmission` with `stdout` populated.
 */
describe('runner — emit writes stdout when HookEmission.stdout is set', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevBaseUrl: string | undefined;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__test_exit__');
    }) as never);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as never);
    prevBaseUrl = process.env.AXTAR_ENGINE_URL;
    process.env.AXTAR_ENGINE_URL = ENGINE_URL;
  });
  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    if (prevBaseUrl === undefined) delete process.env.AXTAR_ENGINE_URL;
    else process.env.AXTAR_ENGINE_URL = prevBaseUrl;
  });

  it('writes the adapter-returned stdout payload to process.stdout (codex envelope shape)', async () => {
    // Engine returns a real PreToolUse block verdict, claude-code-side
    // assemble runs (file_path under tmpdir is fine for the mock —
    // engine answer is what drives output).
    const tmpFile = '/tmp/axtar-runner-stdout-probe.txt';
    require('node:fs').writeFileSync(tmpFile, 'old');
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 'AXT-X-1',
                name: 'x',
                altitude: 'implementation',
                severity: 'blocking',
                language: 'java',
                paths: ['**/*.txt'],
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (u.endsWith('/evaluate')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              verdict: 'block',
              violations: [
                {
                  rule_id: 'AXT-X-1',
                  severity: 'blocking',
                  message: 'block this',
                  foundation: null,
                  fix_suggestion: null,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    // Adapter that always returns stdout-bearing HookEmission, so we
    // know whether the runner's emit path writes it.
    const stdoutAdapter = {
      render: () => ({ exitCode: 0, stdout: 'EMITTED_PAYLOAD_42' }),
      renderEngineUnreachable: () => ({ exitCode: 0, stderr: '' }),
    };

    const stdin = JSON.stringify({
      session_id: 's',
      tool_name: 'Edit',
      tool_input: {
        file_path: tmpFile,
        old_string: 'old',
        new_string: 'new',
      },
    });

    await expect(
      run(stdin, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: stdoutAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    const stdoutCalls = stdoutSpy.mock.calls.map(([chunk]: [unknown]) => String(chunk));
    expect(stdoutCalls).toContain('EMITTED_PAYLOAD_42');

    require('node:fs').rmSync(tmpFile, { force: true });
  });
});

/**
 * Runner wiring of the v1 PostToolUse drift advisory (I1).
 *
 * A Post run with `consult_required:true` and a non-empty rule_set must surface
 * the rule-scoped reminder in the Post output AND keep the exit code identical
 * to the plain Post verdict (the reminder never changes exit semantics). Here
 * the verdict is `block` on Post → exit 2 per the adapter (cosmetic harness
 * label; the edit already landed), so we assert the advisory rides that exit 2.
 */
describe('runner — PostToolUse drift advisory wiring', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let prevBaseUrl: string | undefined;
  let exitCode: number | undefined;
  const TMP_FILE = '/tmp/axtar-drift-runner-probe.txt';

  beforeEach(() => {
    require('node:fs').writeFileSync(TMP_FILE, 'old');
    exitCode = undefined;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error('__test_exit__');
    }) as never);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((_chunk: unknown) => true) as never);
    prevBaseUrl = process.env.AXTAR_ENGINE_URL;
    process.env.AXTAR_ENGINE_URL = ENGINE_URL;
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    require('node:fs').rmSync(TMP_FILE, { force: true });
    if (prevBaseUrl === undefined) delete process.env.AXTAR_ENGINE_URL;
    else process.env.AXTAR_ENGINE_URL = prevBaseUrl;
  });

  function stderrText(): string {
    return stderrSpy.mock.calls.map(([c]: [unknown]) => String(c)).join('');
  }

  it('Post + consult_required + non-empty rule_set → advisory in output, exit code unchanged', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) {
        return Promise.resolve(
          rulesResponse([
            {
              id: 'AXT-X-1',
              name: 'x',
              altitude: 'implementation',
              severity: 'warning',
              language: 'java',
              paths: ['**/*.txt'],
            },
          ]),
        );
      }
      if (u.endsWith('/evaluate')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              verdict: 'block',
              violations: [
                {
                  rule_id: 'AXT-X-1',
                  severity: 'warning',
                  message: 'post advisory',
                  foundation: null,
                  fix_suggestion: null,
                },
              ],
              consult_required: true,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    const stdin = JSON.stringify({
      session_id: 's',
      tool_name: 'Edit',
      tool_input: { file_path: TMP_FILE, old_string: 'old', new_string: 'new' },
    });

    await expect(
      run(stdin, {
        hook: 'PostToolUse',
        severities: new Set(['warning', 'suggestion']),
        parseInput: parseHookInput,
        assemble: assembleForPost,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    // Post block verdict → exit 2 (the reminder rides it, does not change it).
    expect(exitCode).toBe(2);
    expect(stderrText()).toContain('high-altitude Mentor governance');
    expect(stderrText()).toContain('full substance-drift review lands in v2');
    expect(stderrText()).toContain('AXT-X-1');
  });
});

/**
 * Runner wiring of the Post-hook Rung-2 heartbeat (D-063 secondary).
 *
 * On a high-altitude (consult_required) PostToolUse edit under Rung 2, the runner
 * resolves the rung (best-effort) and the adapter emits a terse reminder on the
 * exit-0 additionalContext channel (the agent-visible Post channel; exit-2 ignores
 * JSON, exit-0 stderr is debug-only). Rung 1 / policy failure → no heartbeat.
 */
function policyResponse(rung: string): Response {
  return new Response(JSON.stringify({ autonomy_rung: rung }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runner — PostToolUse Rung-2 heartbeat (D-063)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevBaseUrl: string | undefined;
  let exitCode: number | undefined;
  const TMP = '/tmp/axtar-heartbeat-probe.txt';

  beforeEach(() => {
    require('node:fs').writeFileSync(TMP, 'old');
    exitCode = undefined;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error('__test_exit__');
    }) as never);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_c: unknown) => true) as never);
    prevBaseUrl = process.env.AXTAR_ENGINE_URL;
    process.env.AXTAR_ENGINE_URL = ENGINE_URL;
  });
  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    require('node:fs').rmSync(TMP, { force: true });
    if (prevBaseUrl === undefined) delete process.env.AXTAR_ENGINE_URL;
    else process.env.AXTAR_ENGINE_URL = prevBaseUrl;
  });
  function stdoutText(): string {
    return stdoutSpy.mock.calls.map(([c]: [unknown]) => String(c)).join('');
  }
  // A warning rule on **/*.txt survives the Post pre-filter; /evaluate returns a
  // pass verdict (exit 0) with consult_required:true (high-altitude file).
  function postFetch(rung: string) {
    return (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) {
        return Promise.resolve(
          rulesResponse([
            {
              id: 'AXT-X-1',
              name: 'x',
              altitude: 'implementation',
              severity: 'warning',
              language: 'java',
              paths: ['**/*.txt'],
              engine: 'llm',
            },
          ]),
        );
      }
      if (u.endsWith('/evaluate')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ verdict: 'pass', violations: [], consult_required: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (u.endsWith('/policy')) return Promise.resolve(policyResponse(rung));
      return Promise.resolve(new Response('not reached', { status: 500 }));
    };
  }
  const STDIN = JSON.stringify({
    session_id: 's',
    tool_name: 'Edit',
    tool_input: { file_path: TMP, old_string: 'old', new_string: 'new' },
  });

  it('rung2 + consult_required + pass verdict → additionalContext heartbeat on stdout (exit 0)', async () => {
    fetchSpy.mockImplementation(postFetch('rung2_gate_certified'));
    await expect(
      run(STDIN, {
        hook: 'PostToolUse',
        severities: new Set(['warning', 'suggestion']),
        parseInput: parseHookInput,
        assemble: assembleForPost,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdoutText()) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(env.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    const heartbeat = env.hookSpecificOutput?.additionalContext ?? '';
    expect(heartbeat).toContain('Rung 2');
    // Same contract as the block framing: a configured-policy reminder, never a
    // "don't ask the human" imperative (injection-shaped in tool output) and no
    // PR pre-instruction (post-approval workflow doesn't belong in a hook channel).
    expect(heartbeat.toLowerCase()).toContain('configured');
    expect(heartbeat.toLowerCase()).not.toContain("don't stop to ask");
    expect(heartbeat.toLowerCase()).not.toContain('do not stop to ask');
    expect(heartbeat.toLowerCase()).not.toContain('pull request');
  });

  it('rung1 → no heartbeat on stdout', async () => {
    fetchSpy.mockImplementation(postFetch('rung1_autonomous_fix'));
    await expect(
      run(STDIN, {
        hook: 'PostToolUse',
        severities: new Set(['warning', 'suggestion']),
        parseInput: parseHookInput,
        assemble: assembleForPost,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');
    expect(stdoutText()).toBe('');
  });
});
