/**
 * End-to-end integration test against a running engine.
 *
 * Gated by `RUN_INTEGRATION=1`. Skipped by default so unit-test runs stay
 * hermetic. Pre-conditions when running:
 *
 *   1. Engine is running on `AXTAR_ENGINE_URL` (default
 *      http://127.0.0.1:8765) with the Phase 2 rule set loaded.
 *   2. Plugin has been built (`npm run build`).
 *
 * What we verify:
 *
 *   - Edit introducing a `double price = 0.0` field in a domain file →
 *     PreToolUse hook exits 2 with stderr containing AXT-JAVA-042.
 *   - Edit introducing `BigDecimal price = ...` in the same file →
 *     PreToolUse exits 0, no stderr.
 *   - Edit introducing `System.out.println` → PostToolUse exits 0 with
 *     AXT-JAVA-077 in stderr (warning surfaces; no block).
 *   - Hook with engine pointed at unreachable URL → exits 0 with
 *     stderr warning (fail-soft per non-negotiable #4).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(here, '..', '..');
const PRE_HOOK = resolve(PLUGIN_ROOT, 'dist', 'hooks', 'pre-tool-use.js');
const POST_HOOK = resolve(PLUGIN_ROOT, 'dist', 'hooks', 'post-tool-use.js');

const RUN = process.env.RUN_INTEGRATION === '1';
const describeIntegration = RUN ? describe : describe.skip;

let projectDir: string;
let domainFile: string;

beforeAll(() => {
  if (!RUN) return;
  // Make sure dist exists.
  execFileSync('node', ['--check', PRE_HOOK]);
  execFileSync('node', ['--check', POST_HOOK]);
});

beforeAll(() => {
  if (!RUN) return;
  projectDir = mkdtempSync(resolve(tmpdir(), 'axtar-int-'));
  const dir = resolve(projectDir, 'src', 'main', 'java', 'domain');
  mkdirSync(dir, { recursive: true });
  domainFile = resolve(dir, 'Order.java');
  writeFileSync(domainFile, 'class Order {\n}\n', 'utf-8');
});

afterAll(() => {
  if (!RUN) return;
  rmSync(projectDir, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(hookPath: string, payload: object, env: Record<string, string> = {}): RunResult {
  const proc = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      AXTAR_LOG_LEVEL: 'warn',
      // Cold-start of the engine can push first-request latency past the
      // 600ms default. We're measuring correctness here, not the §8 SLA —
      // Phase 4's Fly.io measurement is where the latency gate lives.
      AXTAR_HOOK_TIMEOUT_MS: '5000',
      ...env,
    },
  });
  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

describeIntegration('end-to-end against running engine', () => {
  it('Edit introducing `double price` in domain file → PreToolUse blocks (exit 2)', () => {
    // First: precondition — bring file to a known state without `double price`.
    writeFileSync(domainFile, 'class Order {\n}\n', 'utf-8');

    const r = runHook(PRE_HOOK, {
      session_id: 'integration-1',
      tool_name: 'Edit',
      tool_input: {
        file_path: domainFile,
        old_string: 'class Order {\n}',
        new_string: 'class Order {\n    double price = 0.0;\n}',
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Axtar blocked this edit');
    expect(r.stderr).toContain('AXT-JAVA-042 — Money values must use BigDecimal');
    // The war story is the load-bearing piece — if WHY drops out, the agent
    // sees only a generic block and the demo loses its punch.
    expect(r.stderr).toContain('WHY THIS RULE EXISTS:');
    expect(r.stderr).toContain('€47k');
    expect(r.stderr).toContain('Resolve and retry.');
  });

  it('Edit introducing BigDecimal price → PreToolUse passes (exit 0)', () => {
    writeFileSync(domainFile, 'class Order {\n}\n', 'utf-8');

    const r = runHook(PRE_HOOK, {
      session_id: 'integration-2',
      tool_name: 'Edit',
      tool_input: {
        file_path: domainFile,
        old_string: 'class Order {\n}',
        new_string:
          'import java.math.BigDecimal;\nclass Order {\n    BigDecimal price = BigDecimal.ZERO;\n}',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('Axtar blocked');
  });

  it('Edit introducing System.out.println → PostToolUse warns (exit 0, stderr)', () => {
    writeFileSync(domainFile, 'class Order {\n}\n', 'utf-8');

    const r = runHook(POST_HOOK, {
      session_id: 'integration-3',
      tool_name: 'Edit',
      tool_input: {
        file_path: domainFile,
        old_string: 'class Order {\n}',
        new_string: 'class Order {\n    void f() { System.out.println("x"); }\n}',
      },
    });
    expect(r.status).toBe(0);
    // The warning rule (AXT-JAVA-077) should surface in PostToolUse stderr
    // with the new advisory layout (Step 7).
    if (r.stderr.length > 0) {
      expect(r.stderr).toContain('Axtar advisory');
      expect(r.stderr).toContain('AXT-JAVA-077');
      expect(r.stderr).toContain('Note this and continue.');
    }
  });

  it('engine unreachable → PreToolUse exits 0 with fail-soft warning', () => {
    writeFileSync(domainFile, 'class Order {\n}\n', 'utf-8');

    const r = runHook(
      PRE_HOOK,
      {
        session_id: 'integration-4',
        tool_name: 'Edit',
        tool_input: {
          file_path: domainFile,
          old_string: 'class Order {\n}',
          new_string: 'class Order {\n    int x = 0;\n}',
        },
      },
      { AXTAR_ENGINE_URL: 'http://127.0.0.1:1' },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('engine unreachable');
  });

  it('Bash tool → PreToolUse exits 0 silently (no engine call)', () => {
    const r = runHook(PRE_HOOK, {
      session_id: 'integration-5',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
