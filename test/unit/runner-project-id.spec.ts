/**
 * Runner-level project binding (project_id scoping). Drives the real shared
 * `run()` on the PreToolUse path with mocked fetch + process.exit, and asserts
 * the BOUND project id (from `.axtar/config.json`) rides on the /evaluate and
 * /gate request bodies — so the server enforces exactly that project's pool.
 * Unbound repos must send no `project_id` (org-wide scope, back-compat).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeCodeOutputAdapter } from '../../src/hosts/claude-code/adapter.js';
import { assembleForPre, parseHookInput } from '../../src/hosts/claude-code/assemble.js';
import { saveProjectSelection } from '../../src/shared/project/config.js';
import { run } from '../../src/shared/runner.js';

const ENGINE_URL = 'http://127.0.0.1:9999';
const PROJECT_ID = '2267f93e-8166-4480-a669-02de999c6ae9';

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

function evaluateResponse(consultRequired: boolean): Response {
  return new Response(
    JSON.stringify({ verdict: 'pass', violations: [], consult_required: consultRequired }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function gateCleared(): Response {
  return new Response(
    JSON.stringify({ cleared: true, triggered_rule_ids: ['AXT-X-1'], reason: 'signoff_found' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('runner — project_id scoping on /evaluate and /gate', () => {
  let projectDir: string;
  let filePath: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let prevBaseUrl: string | undefined;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'axtar-pid-'));
    filePath = join(projectDir, 'Foo.txt');
    writeFileSync(filePath, 'old');
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__test_exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((_c: unknown) => true) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((_c: unknown) => true) as never);
    prevBaseUrl = process.env.AXTAR_ENGINE_URL;
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.AXTAR_ENGINE_URL = ENGINE_URL;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectDir, { recursive: true, force: true });
    if (prevBaseUrl === undefined) delete process.env.AXTAR_ENGINE_URL;
    else process.env.AXTAR_ENGINE_URL = prevBaseUrl;
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  });

  function stdin(): string {
    return JSON.stringify({
      session_id: 'host-session-xyz',
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: 'old', new_string: 'new' },
    });
  }

  function bodyFor(path: string): Record<string, unknown> | undefined {
    const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith(path));
    const init = call?.[1] as { body?: string } | undefined;
    return init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  }

  async function runPre(): Promise<void> {
    await expect(
      run(stdin(), {
        hook: 'PreToolUse',
        severities: new Set(['blocking']),
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
      }),
    ).rejects.toThrow('__test_exit__');
  }

  it('bound repo → project_id on the /evaluate and /gate bodies', async () => {
    saveProjectSelection(projectDir, { id: PROJECT_ID, name: 'p' }, '2026-06-29T00:00:00Z');
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateResponse(true));
      if (u.endsWith('/gate')) return Promise.resolve(gateCleared());
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    await runPre();

    expect(bodyFor('/evaluate')?.project_id).toBe(PROJECT_ID);
    expect(bodyFor('/gate')?.project_id).toBe(PROJECT_ID);
    // and the rules fetch is scoped too (existing behaviour, asserted for completeness)
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes(`project_id=${PROJECT_ID}`))).toBe(
      true,
    );
  });

  it('unbound repo → no project_id key on the wire', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes('/rules')) return Promise.resolve(rulesResponse());
      if (u.endsWith('/evaluate')) return Promise.resolve(evaluateResponse(false));
      return Promise.resolve(new Response('not reached', { status: 500 }));
    });

    await runPre();

    const evalBody = bodyFor('/evaluate');
    expect(evalBody && 'project_id' in evalBody).toBe(false);
  });
});
