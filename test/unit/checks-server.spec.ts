/**
 * The two tools, with the engine client and the packet producer stubbed.
 *
 * What is asserted here is behaviour the spec makes non-negotiable, not code
 * paths: an unset-up repo **refuses** (and says the refusal is not a verdict),
 * a platform failure **fails open** (§12), a drifted body is **shown, degraded**,
 * and every judgment **leads with the receipt block** (§10).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineClient, EngineResult, ResponseParser } from '../../src/shared/engine/client.js';
import type { DiffPacket, ProduceOptions, ProducerOutcome } from '../../src/shared/producer.js';
import {
  CHECK_DIFF_DESCRIPTION,
  SERVER_NAME,
  createServer,
  runCheckDiff,
  runCheckSpec,
} from '../../src/mcp/checks-server.js';
import type { ServerDeps } from '../../src/mcp/checks-server.js';

const PROJECT = '3f6a2c18-9b1e-4c5a-9a2f-1d0e7b4c8a55';

const DIFF_BODY = {
  check_id: PROJECT,
  url: `https://app.axtar.dev/checks/${PROJECT}`,
  verdict: 'breaches',
  breaches: [
    {
      rule_id: 'AXT-0001',
      rule_version: 1,
      severity: 'must',
      path: 'src/api/handler.ts',
      line: 42,
      evidence_quote: 'throw new Error("x");',
      why: 'The refund is issued with no approval check.',
      fix: 'Gate the refund on an approval.',
      source: { kind: 'stated', ref: 'docs/refunds.md', excerpt: '…' },
      defended: true,
      cache_sourced: false,
    },
  ],
  advisories: [],
  unmet_spec: [],
  considered: 212,
  checked: 209,
  dropped: [{ rule_id: 'AXT-0003', reason: 'packet_cap' }],
  receipt: '212 considered · 209 checked · 1 dropped · 1 breaches · 0 advisories',
};

const SPEC_BODY = {
  check_id: PROJECT,
  url: `https://app.axtar.dev/checks/${PROJECT}`,
  verdict: 'needs_revision',
  must_state: [
    {
      rule_id: 'AXT-0001',
      rule_version: 1,
      statement: 'A refund can never exceed the original charge.',
      why: 'The plan adds refunds and never bounds the amount.',
      line_for_the_spec: 'The refund amount must never exceed the original charge.',
      source: { kind: 'stated', ref: 'docs/refunds.md', excerpt: null },
    },
  ],
  conflicts: [],
  unaddressed: [],
  open_questions: ['Which service owns the ledger entry?'],
  considered: 88,
  checked: 88,
  dropped: [],
  receipt: '88 considered · 88 checked · 0 dropped · 1 must-state · 0 conflicts',
};

const PACKET: DiffPacket = {
  repoRoot: '/repo',
  baseRef: 'abc1234def5678',
  baseRefLabel: 'merge-base of HEAD and origin/main',
  diff: 'diff --git a/src/api/handler.ts b/src/api/handler.ts\n',
  files: [{ path: 'src/api/handler.ts', content: 'const a = 1;\n' }],
  branch: 'feat/refunds',
  binarySkipped: ['assets/logo.png'],
  untracked: ['src/api/new.ts'],
};

interface Posted {
  path: string;
  body: unknown;
}

let repoDir: string;
let posted: Posted[];

/** A client that answers every POST with `body`, through the caller's parser. */
function clientReturning(body: unknown): EngineClient {
  return {
    post: async <T>(path: string, requestBody: unknown, schema: ResponseParser<T>) => {
      posted.push({ path, body: requestBody });
      return { ok: true, value: schema.parse(body) } satisfies EngineResult<T>;
    },
  };
}

function clientFailing(failure: Exclude<EngineResult<never>, { ok: true }>): EngineClient {
  return {
    post: async (path, requestBody) => {
      posted.push({ path, body: requestBody });
      return failure;
    },
  };
}

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    env: { AXTAR_ENGINE_URL: 'https://app.axtar.dev/mentor', AXTAR_API_KEY: 'axtar_pk_test' },
    cwd: repoDir,
    createClient: () => clientReturning(DIFF_BODY),
    produce: async (_options: ProduceOptions): Promise<ProducerOutcome<DiffPacket>> => ({
      ok: true,
      value: PACKET,
    }),
    readSpecFile: () => '# plan\n',
    ...over,
  };
}

function bodyOf(result: Awaited<ReturnType<typeof runCheckDiff>>): string {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

function writeConfig(projectId: string): void {
  mkdirSync(join(repoDir, '.axtar'), { recursive: true });
  writeFileSync(join(repoDir, '.axtar', 'config.yml'), `version: 1\nproject: ${projectId}\n`);
}

beforeEach(() => {
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'axtar-server-')));
  posted = [];
  writeConfig(PROJECT);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('refusals — the tools never check against nothing', () => {
  it('refuses without a .axtar/config.yml, and says where to get one', async () => {
    rmSync(join(repoDir, '.axtar'), { recursive: true, force: true });

    const body = bodyOf(await runCheckDiff({}, deps()));

    expect(body).toContain('.axtar/config.yml');
    expect(body).toContain('Axtar portal');
    expect(body).toContain('This is not a verdict');
    expect(posted).toEqual([]);
  });

  it('refuses without the connection env vars, naming both', async () => {
    const body = bodyOf(await runCheckSpec({ spec: '# plan' }, deps({ env: {} })));

    expect(body).toContain('AXTAR_ENGINE_URL');
    expect(body).toContain('AXTAR_API_KEY');
    expect(body).toContain('This is not a verdict');
    expect(posted).toEqual([]);
  });

  it('reports the binding and the connection together when both are missing', async () => {
    rmSync(join(repoDir, '.axtar'), { recursive: true, force: true });

    const body = bodyOf(await runCheckDiff({}, deps({ env: {} })));

    expect(body).toContain('.axtar/config.yml');
    expect(body).toContain('AXTAR_API_KEY');
  });

  it('refuses a config bound to nothing', async () => {
    writeFileSync(join(repoDir, '.axtar', 'config.yml'), 'version: 1\nproject:\n');

    const body = bodyOf(await runCheckDiff({}, deps()));

    expect(body).toContain("no top-level 'project:'");
  });

  it('reports a producer failure as a local problem, not a verdict', async () => {
    const body = bodyOf(
      await runCheckDiff(
        {},
        deps({
          produce: async () => ({ ok: false, reason: 'no_base_ref', detail: 'nothing resolved' }),
        }),
      ),
    );

    expect(body).toContain('could not assemble the diff packet');
    expect(body).toContain('Pass base_ref explicitly');
    expect(body).toContain('This is not a verdict');
    expect(posted).toEqual([]);
  });
});

describe('axtar_check_diff', () => {
  it('ships the producer-built packet and leads with the receipt block', async () => {
    const body = bodyOf(await runCheckDiff({}, deps()));

    expect(body.split('\n').slice(0, 3)).toEqual([
      `check_id: ${PROJECT}`,
      `url:      https://app.axtar.dev/checks/${PROJECT}`,
      'summary:  212 considered · 209 checked · 1 dropped · 1 breaches · 0 advisories',
    ]);
    expect(posted).toEqual([
      {
        path: '/checks/diff',
        body: {
          project: PROJECT,
          diff: PACKET.diff,
          base_ref: PACKET.baseRef,
          files: PACKET.files,
          ref: 'feat/refunds',
        },
      },
    ]);
  });

  it('renders the breach with its rule ref, location, evidence, why, fix and source', async () => {
    const body = bodyOf(await runCheckDiff({}, deps()));

    expect(body).toContain('AXT-0001@1 · must · src/api/handler.ts:42 · defended');
    expect(body).toContain('throw new Error("x");');
    expect(body).toContain('The refund is issued with no approval check.');
    expect(body).toContain('Gate the refund on an approval.');
    expect(body).toContain('stated · docs/refunds.md');
  });

  it('names the rules that were not judged (invariant #9)', async () => {
    expect(bodyOf(await runCheckDiff({}, deps()))).toContain('AXT-0003 (packet_cap)');
  });

  it('tells the agent to surface the receipt', async () => {
    expect(bodyOf(await runCheckDiff({}, deps()))).toContain('PR description');
  });

  it('reports what the producer did, after the judgment', async () => {
    const body = bodyOf(await runCheckDiff({}, deps()));

    expect(body).toContain('packet: 1 file(s) sent whole');
    expect(body).toContain('merge-base of HEAD and origin/main');
    expect(body).toContain('1 untracked included');
    expect(body).toContain('1 binary skipped (assets/logo.png)');
  });

  it('passes base_ref through to the producer and prefers an explicit ref', async () => {
    const seen: ProduceOptions[] = [];

    await runCheckDiff(
      { base_ref: 'origin/release', ref: 'PR-42' },
      deps({
        produce: async (options) => {
          seen.push(options);
          return { ok: true, value: PACKET };
        },
      }),
    );

    expect(seen[0]?.baseRef).toBe('origin/release');
    expect(posted[0]?.body).toMatchObject({ ref: 'PR-42' });
  });

  it('omits ref entirely when HEAD is detached and the caller named none', async () => {
    await runCheckDiff(
      {},
      deps({ produce: async () => ({ ok: true, value: { ...PACKET, branch: null } }) }),
    );

    expect(posted[0]?.body).not.toHaveProperty('ref');
  });

  it('reads spec_path from disk rather than taking pasted contents', async () => {
    const read: string[] = [];

    await runCheckDiff(
      { spec_path: 'docs/plan.md' },
      deps({
        readSpecFile: (path) => {
          read.push(path);
          return '# the plan\n';
        },
      }),
    );

    expect(read).toEqual([join(repoDir, 'docs', 'plan.md')]);
    expect(posted[0]?.body).toMatchObject({ spec: '# the plan\n' });
  });

  it('refuses an unreadable spec_path without shipping the packet', async () => {
    const body = bodyOf(
      await runCheckDiff(
        { spec_path: 'docs/missing.md' },
        deps({
          readSpecFile: () => {
            throw new Error('ENOENT: no such file');
          },
        }),
      ),
    );

    expect(body).toContain('could not be read');
    expect(posted).toEqual([]);
  });

  it('rejects an argument it does not know instead of silently dropping it', async () => {
    const body = bodyOf(await runCheckDiff({ diff: 'pasted by the agent' }, deps()));

    expect(body).toContain('arguments it cannot use');
    expect(posted).toEqual([]);
  });
});

describe('axtar_check_spec', () => {
  it('checks pasted spec text and leads with the receipt', async () => {
    const body = bodyOf(
      await runCheckSpec(
        { spec: '# Refunds\n' },
        deps({ createClient: () => clientReturning(SPEC_BODY) }),
      ),
    );

    expect(body.split('\n')[0]).toBe(`check_id: ${PROJECT}`);
    expect(body).toContain('advisory — a spec check never gates');
    expect(posted).toEqual([
      { path: '/checks/spec', body: { project: PROJECT, spec: '# Refunds\n' } },
    ]);
  });

  it('renders must_state as ready-to-paste spec lines, then the detail', async () => {
    const body = bodyOf(
      await runCheckSpec(
        { spec: '# Refunds\n' },
        deps({ createClient: () => clientReturning(SPEC_BODY) }),
      ),
    );

    expect(body).toContain('MUST STATE (1) — paste these lines into the spec:');
    expect(body).toContain('- The refund amount must never exceed the original charge.');
    expect(body).toContain('AXT-0001@1');
    expect(body).toContain('OPEN QUESTIONS (1)');
    expect(body).toContain('Which service owns the ledger entry?');
  });

  it('reads spec_path from disk', async () => {
    const read: string[] = [];

    await runCheckSpec(
      { spec_path: 'docs/plan.md', ref: 'spec-17' },
      deps({
        createClient: () => clientReturning(SPEC_BODY),
        readSpecFile: (path) => {
          read.push(path);
          return '# from disk\n';
        },
      }),
    );

    expect(read).toEqual([join(repoDir, 'docs', 'plan.md')]);
    expect(posted[0]?.body).toEqual({
      project: PROJECT,
      spec: '# from disk\n',
      ref: 'spec-17',
    });
  });

  it('requires exactly one of spec and spec_path — neither', async () => {
    const body = bodyOf(await runCheckSpec({}, deps()));

    expect(body).toContain('exactly one of `spec` or `spec_path`');
    expect(posted).toEqual([]);
  });

  it('requires exactly one of spec and spec_path — both', async () => {
    const body = bodyOf(await runCheckSpec({ spec: '# a', spec_path: 'b.md' }, deps()));

    expect(body).toContain('exactly one of `spec` or `spec_path`');
    expect(posted).toEqual([]);
  });
});

describe('fail open (§12)', () => {
  it('returns text, not an exception, on a 500', async () => {
    const body = bodyOf(
      await runCheckDiff(
        {},
        deps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 500, detail: 'boom' }),
        }),
      ),
    );

    expect(body).toContain('could not run the diff check');
    expect(body).toContain('HTTP 500 — boom');
    expect(body).toContain('No verdict exists');
    expect(body).toContain('Work may proceed');
  });

  it('returns text on a timeout', async () => {
    const body = bodyOf(
      await runCheckSpec(
        { spec: '# plan' },
        deps({
          createClient: () => clientFailing({ ok: false, reason: 'timeout', detail: '>310000ms' }),
        }),
      ),
    );

    expect(body).toContain('could not run the spec check');
    expect(body).toContain('timeout — >310000ms');
    expect(body).toContain('Work may proceed');
  });

  it('turns the actionable statuses into advice', async () => {
    const unauthorized = bodyOf(
      await runCheckDiff(
        {},
        deps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 401, detail: 'bad key' }),
        }),
      ),
    );
    expect(unauthorized).toContain('AXTAR_API_KEY was rejected');

    const missingProject = bodyOf(
      await runCheckDiff(
        {},
        deps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 404, detail: 'project not found' }),
        }),
      ),
    );
    expect(missingProject).toContain(PROJECT);
    expect(missingProject).toContain('.axtar/config.yml');

    const noProvider = bodyOf(
      await runCheckDiff(
        {},
        deps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 409, detail: 'no provider' }),
        }),
      ),
    );
    expect(noProvider).toContain('LLM provider');
  });
});

describe('schema drift', () => {
  it('shows the drifted body, warns, and still leads with the salvaged receipt', async () => {
    const drifted = { ...DIFF_BODY, breaches: 'now a string', extra_field: 1 };

    const body = bodyOf(
      await runCheckDiff({}, deps({ createClient: () => clientReturning(drifted) })),
    );

    expect(body.split('\n')[0]).toBe(`check_id: ${PROJECT}`);
    expect(body).toContain('Schema drift');
    expect(body).toContain('breaches:');
    expect(body).toContain('now a string');
    expect(body).toContain('/plugin update axtar');
  });

  it('degrades a spec response with no receipt to rescue', async () => {
    const body = bodyOf(
      await runCheckSpec(
        { spec: '# plan' },
        deps({ createClient: () => clientReturning({ verdict: 'ready' }) }),
      ),
    );

    expect(body).toContain('Schema drift');
    expect(body).toContain('"verdict": "ready"');
  });
});

describe('the server itself', () => {
  it('registers both tools with descriptions that carry the receipt instruction', async () => {
    const server = createServer(deps());
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'axtar_check_diff',
      'axtar_check_spec',
    ]);
    for (const tool of listed.tools) {
      expect(tool.description).toContain('receipt block');
      expect(tool.inputSchema.properties).toHaveProperty('ref');
    }
    await client.close();
    await server.close();
  });

  it('runs a tool end to end over the transport', async () => {
    const server = createServer(deps());
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'axtar_check_diff', arguments: {} });

    expect(JSON.stringify(result.content)).toContain('212 considered');
    await client.close();
    await server.close();
  });

  it('fails open rather than surfacing an exception when a handler throws', async () => {
    const server = createServer(
      deps({
        produce: () => {
          throw new Error('producer exploded');
        },
      }),
    );
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'axtar_check_diff', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('No verdict exists');
    expect(JSON.stringify(result.content)).toContain('producer exploded');
    await client.close();
    await server.close();
  });

  it('is the server the manifests point at', () => {
    expect(SERVER_NAME).toBe('axtar');
    expect(CHECK_DIFF_DESCRIPTION).toContain('Pass NO diff and NO file contents');
  });
});
