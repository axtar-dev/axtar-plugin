/**
 * Runner-level Mentor gate wiring (G1) — block, bypass, and the FAIL-SOFT
 * audit-also-down guarantee.
 *
 * Drives the real shared `run()` on the PreToolUse path with mocked fetch +
 * process.exit (mirrors runner.spec.ts). The engine returns
 * `consult_required: true`, so the runner consults /gate.
 *
 * The non-negotiable property under test: when the gate is unreachable AND
 * the /bypass audit ALSO fails (engine fully down), the runner STILL
 * emits the bypass advisory and exits 0 (edit allowed). The audit failure
 * must not change the allow decision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeCodeOutputAdapter } from '../../src/hosts/claude-code/adapter.js';
import { assembleForPre, parseHookInput } from '../../src/hosts/claude-code/assemble.js';
import { run } from '../../src/shared/runner.js';

const ENGINE_URL = 'http://127.0.0.1:9999';
const TMP_FILE = '/tmp/axtar-gate-runner-probe.txt';

function rulesResponse(): Response {
  return new Response(
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
  );
}

function evaluateConsultRequired(): Response {
  return new Response(JSON.stringify({ verdict: 'pass', violations: [], consult_required: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function policyResponse(rung: string): Response {
  return new Response(JSON.stringify({ autonomy_rung: rung }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deniedGate(): Response {
  return new Response(
    JSON.stringify({ cleared: false, triggered_rule_ids: ['AXT-X-1'], reason: 'consult_required' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const STDIN = JSON.stringify({
  session_id: 'host-session-xyz',
  tool_name: 'Edit',
  tool_input: { file_path: TMP_FILE, old_string: 'old', new_string: 'new' },
});

describe('runner — mentor gate wiring', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevBaseUrl: string | undefined;
  let exitCode: number | undefined;

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
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((_chunk: unknown) => true) as never);
    prevBaseUrl = process.env.AXTAR_ENGINE_URL;
    process.env.AXTAR_ENGINE_URL = ENGINE_URL;
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    require('node:fs').rmSync(TMP_FILE, { force: true });
    if (prevBaseUrl === undefined) delete process.env.AXTAR_ENGINE_URL;
    else process.env.AXTAR_ENGINE_URL = prevBaseUrl;
  });

  function stderrText(): string {
    return stderrSpy.mock.calls.map(([c]: [unknown]) => String(c)).join('');
  }

  it('BLOCK: gate ok + not cleared → exit 2 + consult advisory carrying host session id', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateConsultRequired());
      if (u.endsWith('/gate')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ cleared: false, triggered_rule_ids: ['AXT-X-1'], reason: 'consult' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    await expect(
      run(STDIN, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    expect(exitCode).toBe(2);
    expect(stderrText()).toContain('host-session-xyz');
    expect(stderrText()).toContain('consult');
    // Claude Code path is UNCHANGED: a hard block, never the advisory-and-
    // proceed path taken by a host without the consult tool. No "v1-deferred"
    // advisory wording leaks in.
    expect(stderrText()).not.toContain('v1-deferred');
    expect(stderrText()).not.toContain('NOT a mandatory gate');
    // No bypass audit attempted on a real denial.
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.endsWith('/bypass'))).toBe(false);
  });

  it('FAIL-SOFT: gate unreachable AND bypass audit also fails → still exit 0 + advisory', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateConsultRequired());
      // Gate AND bypass both reject at the transport layer (engine fully down).
      if (u.endsWith('/gate')) return Promise.reject(new Error('ECONNREFUSED'));
      if (u.endsWith('/bypass')) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    await expect(
      run(STDIN, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    // The allow + advisory survives the audit also being down.
    expect(exitCode).toBe(0);
    expect(stderrText()).toContain('proceeding WITHOUT required consultation');
    // The runner did attempt the best-effort audit.
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.endsWith('/bypass'))).toBe(true);
  });

  it('PROCEED: gate cleared → no block/bypass, falls through to verdict (exit 0)', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateConsultRequired());
      if (u.endsWith('/gate')) {
        return Promise.resolve(
          new Response(JSON.stringify({ cleared: true, triggered_rule_ids: [], reason: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    await expect(
      run(STDIN, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');

    // verdict was 'pass' → exit 0, no mentor envelope on stderr.
    expect(exitCode).toBe(0);
    expect(stderrText()).not.toContain('proceeding WITHOUT required consultation');
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.endsWith('/bypass'))).toBe(false);
  });

  it('RUNG 2: pre block + policy rung2 → block stderr carries the standing authorization', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateConsultRequired());
      if (u.endsWith('/gate')) return Promise.resolve(deniedGate());
      if (u.endsWith('/policy')) return Promise.resolve(policyResponse('rung2_gate_certified'));
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });
    await expect(
      run(STDIN, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');
    expect(exitCode).toBe(2);
    expect(stderrText()).toContain('Rung 2');
    expect(stderrText()).toContain('session_summary');
    expect(stderrText()).toContain('host-session-xyz'); // still the trust anchor
  });

  it('RUNG 1: pre block + policy rung1 → plain consult envelope, NO framing (byte-identical)', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateConsultRequired());
      if (u.endsWith('/gate')) return Promise.resolve(deniedGate());
      if (u.endsWith('/policy')) return Promise.resolve(policyResponse('rung1_autonomous_fix'));
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });
    await expect(
      run(STDIN, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');
    expect(exitCode).toBe(2);
    expect(stderrText()).not.toContain('Rung 2');
    expect(stderrText()).toContain('consult');
  });

  it('FAIL-SAFE: pre block + policy unreachable → Rung 1 (no framing)', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateConsultRequired());
      if (u.endsWith('/gate')) return Promise.resolve(deniedGate());
      if (u.endsWith('/policy')) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });
    await expect(
      run(STDIN, {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');
    expect(exitCode).toBe(2);
    expect(stderrText()).not.toContain('Rung 2');
  });
});
