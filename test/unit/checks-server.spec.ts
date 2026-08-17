/**
 * The tools, with the engine client and the packet producers stubbed.
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
import type {
  DiffPacket,
  ProduceOptions,
  ProducerOutcome,
  ScanPacket,
} from '../../src/shared/producer.js';
import {
  CHECK_DIFF_DESCRIPTION,
  CHECK_SCAN_DESCRIPTION,
  PROJECTS_DESCRIPTION,
  SERVER_NAME,
  createServer,
  runCheckDiff,
  runCheckScan,
  runCheckSpec,
  runProjects,
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

/** `POST /mentor/checks/scan` — the diff body minus `unmet_spec`. */
const SCAN_BODY = {
  check_id: PROJECT,
  url: `https://app.axtar.dev/checks/${PROJECT}`,
  verdict: 'breaches',
  breaches: [
    {
      rule_id: 'AXT-0011',
      rule_version: 2,
      severity: 'must',
      path: 'src/billing/invoice.ts',
      line: 117,
      evidence_quote: 'const total = items.reduce(sum, 0);',
      why: 'Money is summed as a float rather than in minor units.',
      fix: 'Sum in integer minor units.',
      source: { kind: 'stated', ref: 'docs/money.md', excerpt: '…' },
      defended: true,
      cache_sourced: false,
    },
  ],
  advisories: [],
  considered: 212,
  checked: 210,
  dropped: [{ rule_id: 'AXT-0013', reason: 'timeout' }],
  receipt: '212 considered · 210 checked · 1 dropped · 1 breaches · 0 advisories',
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

const OTHER_PROJECT = '9c4b7d21-3e88-4a10-b7f6-2c5e1a90d773';

/** `GET /mentor/projects` — the shape of `api/app/schemas/plugin/project.py`. */
const PROJECTS_BODY = [
  { id: PROJECT, name: 'Refunds Service', repo_full_name: 'acme/refunds', rule_count: 212 },
  { id: OTHER_PROJECT, name: 'Payments Platform', repo_full_name: null, rule_count: 41 },
];

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

const SCAN_PACKET: ScanPacket = {
  files: [{ path: 'src/billing/invoice.ts', content: 'const total = 1;\n' }],
  paths_requested: ['src/billing/**'],
  skipped_binary: ['src/billing/logo.png'],
};

interface Posted {
  path: string;
  body: unknown;
}

let repoDir: string;
let posted: Posted[];
let fetched: string[];
/** Repo roots stamped as checked — what keeps the turn-end reminder quiet. */
let marked: string[];

/** A client that answers every POST and GET with `body`, through the caller's parser. */
function clientReturning(body: unknown): EngineClient {
  return {
    post: async <T>(path: string, requestBody: unknown, schema: ResponseParser<T>) => {
      posted.push({ path, body: requestBody });
      return { ok: true, value: schema.parse(body) } satisfies EngineResult<T>;
    },
    get: async <T>(path: string, schema: ResponseParser<T>) => {
      fetched.push(path);
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
    get: async (path) => {
      fetched.push(path);
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
    findRoot: async (): Promise<ProducerOutcome<string>> => ({ ok: true, value: repoDir }),
    produceScan: async (): Promise<ProducerOutcome<ScanPacket>> => ({
      ok: true,
      value: SCAN_PACKET,
    }),
    readSpecFile: () => '# plan\n',
    markChecked: async (repoRoot: string) => {
      marked.push(repoRoot);
    },
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
  fetched = [];
  marked = [];
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

describe('axtar_check_scan', () => {
  function scanDeps(over: Partial<ServerDeps> = {}): ServerDeps {
    return deps({ createClient: () => clientReturning(SCAN_BODY), ...over });
  }

  it('ships the expanded files and leads with the receipt block', async () => {
    const body = bodyOf(await runCheckScan({ paths: ['src/billing/**'] }, scanDeps()));

    expect(body.split('\n').slice(0, 3)).toEqual([
      `check_id: ${PROJECT}`,
      `url:      https://app.axtar.dev/checks/${PROJECT}`,
      'summary:  212 considered · 210 checked · 1 dropped · 1 breaches · 0 advisories',
    ]);
    expect(posted).toEqual([
      {
        path: '/checks/scan',
        body: {
          project: PROJECT,
          files: SCAN_PACKET.files,
          paths_requested: ['src/billing/**'],
        },
      },
    ]);
  });

  it('expands the globs from the repo root, not the cwd', async () => {
    const seen: { root: string; paths: string[] }[] = [];

    await runCheckScan(
      { paths: ['src/billing/**', 'docs/money.md'] },
      scanDeps({
        findRoot: async () => ({ ok: true, value: '/work/tree' }),
        produceScan: async (root, paths) => {
          seen.push({ root, paths });
          return { ok: true, value: SCAN_PACKET };
        },
      }),
    );

    expect(seen).toEqual([{ root: '/work/tree', paths: ['src/billing/**', 'docs/money.md'] }]);
  });

  it('renders the breach and says the audit gates nothing', async () => {
    const body = bodyOf(await runCheckScan({ paths: ['src/billing/**'] }, scanDeps()));

    expect(body).toContain('a scan gates nothing');
    expect(body).toContain('AXT-0011@2 · must · src/billing/invoice.ts:117 · defended');
    expect(body).toContain('Money is summed as a float rather than in minor units.');
    expect(body).toContain('stated · docs/money.md');
    expect(body).toContain('AXT-0013 (timeout)');
    // A scan has no spec, so the diff's third section must not appear.
    expect(body).not.toContain('UNMET SPEC');
  });

  it('reports what the producer did, after the judgment', async () => {
    const body = bodyOf(await runCheckScan({ paths: ['src/billing/**'] }, scanDeps()));

    expect(body).toContain('packet: 1 file(s) sent whole');
    expect(body).toContain('1 path(s) requested');
    expect(body).toContain('1 binary skipped (src/billing/logo.png)');
  });

  it('sends no ref by default — an audit threads into nothing', async () => {
    await runCheckScan({ paths: ['src/**'] }, scanDeps());

    expect(posted[0]?.body).not.toHaveProperty('ref');
  });

  it('passes a ref through verbatim when the caller threads one', async () => {
    await runCheckScan({ paths: ['src/**'], ref: 'BILL-402' }, scanDeps());

    expect(posted[0]?.body).toMatchObject({ ref: 'BILL-402' });
  });

  it('requires paths, and never posts without them', async () => {
    const missing = bodyOf(await runCheckScan({}, scanDeps()));
    expect(missing).toContain('arguments it cannot use');
    expect(missing).toContain('paths');

    const empty = bodyOf(await runCheckScan({ paths: [] }, scanDeps()));
    expect(empty).toContain('arguments it cannot use');

    expect(posted).toEqual([]);
  });

  it('rejects pasted file contents instead of silently dropping them', async () => {
    const body = bodyOf(
      await runCheckScan({ paths: ['src/**'], files: [{ path: 'a', content: 'x' }] }, scanDeps()),
    );

    expect(body).toContain('arguments it cannot use');
    expect(posted).toEqual([]);
  });

  it('refuses without a .axtar/config.yml, and never posts', async () => {
    rmSync(join(repoDir, '.axtar'), { recursive: true, force: true });

    const body = bodyOf(await runCheckScan({ paths: ['src/**'] }, scanDeps()));

    expect(body).toContain('.axtar/config.yml');
    expect(body).toContain('This is not a verdict');
    expect(posted).toEqual([]);
  });

  it('refuses without the connection env vars, naming both', async () => {
    const body = bodyOf(await runCheckScan({ paths: ['src/**'] }, scanDeps({ env: {} })));

    expect(body).toContain('AXTAR_ENGINE_URL');
    expect(body).toContain('AXTAR_API_KEY');
    expect(body).toContain('This is not a verdict');
    expect(posted).toEqual([]);
  });

  it('reports a glob that matched nothing as a local problem, not a verdict', async () => {
    const body = bodyOf(
      await runCheckScan(
        { paths: ['src/nope/**'] },
        scanDeps({
          produceScan: async () => ({
            ok: false,
            reason: 'no_files_matched',
            detail: 'no files matched — check the paths/globs (asked for: src/nope/**)',
          }),
        }),
      ),
    );

    expect(body).toContain('could not assemble the scan packet');
    expect(body).toContain('no files matched — check the paths/globs');
    expect(body).toContain('This is not a verdict');
    expect(posted).toEqual([]);
  });

  it('reports a non-repo cwd without asking the producer for anything', async () => {
    const body = bodyOf(
      await runCheckScan(
        { paths: ['src/**'] },
        scanDeps({
          findRoot: async () => ({ ok: false, reason: 'not_a_repo', detail: 'no work tree' }),
          produceScan: async () => {
            throw new Error('the producer must not be reached');
          },
        }),
      ),
    );

    expect(body).toContain('could not assemble the scan packet');
    expect(body).toContain('git work tree');
    expect(posted).toEqual([]);
  });

  it('fails open on a 500', async () => {
    const body = bodyOf(
      await runCheckScan(
        { paths: ['src/**'] },
        scanDeps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 500, detail: 'boom' }),
        }),
      ),
    );

    expect(body).toContain('could not run the scan check');
    expect(body).toContain('HTTP 500 — boom');
    expect(body).toContain('No verdict exists');
    expect(body).toContain('Work may proceed');
  });

  it('fails open on a timeout', async () => {
    const body = bodyOf(
      await runCheckScan(
        { paths: ['src/**'] },
        scanDeps({
          createClient: () => clientFailing({ ok: false, reason: 'timeout', detail: '>310000ms' }),
        }),
      ),
    );

    expect(body).toContain('could not run the scan check');
    expect(body).toContain('timeout — >310000ms');
    expect(body).toContain('Work may proceed');
  });

  it('degrades a drifted body but still leads with the salvaged receipt', async () => {
    const body = bodyOf(
      await runCheckScan(
        { paths: ['src/**'] },
        scanDeps({ createClient: () => clientReturning({ ...SCAN_BODY, breaches: 'nope' }) }),
      ),
    );

    expect(body.split('\n')[0]).toBe(`check_id: ${PROJECT}`);
    expect(body).toContain('Schema drift');
    expect(body).toContain('conformance scan');
    expect(body).toContain('/plugin update axtar');
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

describe('axtar_projects — listing is not selecting', () => {
  function projectsDeps(over: Partial<ServerDeps> = {}): ServerDeps {
    return deps({ createClient: () => clientReturning(PROJECTS_BODY), ...over });
  }

  it('lists every project and marks the one this repo is bound to', async () => {
    const body = bodyOf(await runProjects({}, projectsDeps()));

    expect(fetched).toEqual(['/projects']);
    expect(body).toContain('PROJECTS (2)');
    expect(body).toContain('Refunds Service   ← this repo is bound to this project');
    expect(body).toContain('212 in the pool');
    expect(body).toContain('acme/refunds');
    expect(body).toContain('Payments Platform');
    expect(body).toContain('(none linked)');
    expect(body).not.toContain('Payments Platform   ←');
  });

  it('names the bound project and the config it came from', async () => {
    const body = bodyOf(await runProjects({}, projectsDeps()));

    expect(body).toContain(`This repo is bound to project ${PROJECT} ("Refunds Service")`);
    expect(body).toContain(join(repoDir, '.axtar', 'config.yml'));
  });

  it('ends with the snippet for the bound project, the commit rule and the three shapes', async () => {
    const body = bodyOf(await runProjects({}, projectsDeps()));

    expect(body).toContain('.axtar/config.yml at the repo root is the only binding');
    expect(body).toContain(`version: 1\nproject: ${PROJECT}`);
    expect(body).toContain('Commit it');
    expect(body).toContain('before running ingest');
    expect(body).toContain('binding-only');
    expect(body).toContain('docs-only');
    expect(body).toContain('docs+code');
    expect(body).toContain('kind: reference');
    expect(body).toContain('enabled: true');
  });

  it('works in an unbound repo and leads with how to bind it', async () => {
    rmSync(join(repoDir, '.axtar'), { recursive: true, force: true });

    const body = bodyOf(await runProjects({}, projectsDeps()));
    const lines = body.split('\n');

    expect(lines[0]).toBe('This repo is bound to no Axtar project.');
    expect(body).toContain('.axtar/config.yml');
    expect(body).toContain('refuse here');
    // Still lists everything, and offers a real id to bind to.
    expect(body).toContain('PROJECTS (2)');
    expect(body).toContain(`version: 1\nproject: ${PROJECT}`);
    expect(body).not.toContain('← this repo is bound to this project');
    expect(fetched).toEqual(['/projects']);
  });

  it('warns when the config names a project this key cannot see', async () => {
    writeConfig('4b8e0d55-1c2f-4a77-9e31-6f0c8b2a4d19');

    const body = bodyOf(await runProjects({}, projectsDeps()));

    expect(body).toContain('That id is NOT in the list below');
    expect(body).toContain('PROJECTS (2)');
  });

  it('says so when the org has no projects at all', async () => {
    const body = bodyOf(
      await runProjects({}, projectsDeps({ createClient: () => clientReturning([]) })),
    );

    expect(body).toContain('This API key can see no projects');
    expect(body).toContain('<project id from the portal>');
  });

  it('refuses without the connection env vars, and never calls the platform', async () => {
    const body = bodyOf(await runProjects({}, projectsDeps({ env: {} })));

    expect(body).toContain('AXTAR_ENGINE_URL');
    expect(body).toContain('AXTAR_API_KEY');
    expect(body).toContain('/axtar:setup');
    expect(fetched).toEqual([]);
  });

  it('fails open when the platform cannot be reached, keeping the how-to-bind footer', async () => {
    const body = bodyOf(
      await runProjects(
        {},
        projectsDeps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 500, detail: 'boom' }),
        }),
      ),
    );

    expect(body).toContain('could not list your projects');
    expect(body).toContain('HTTP 500 — boom');
    expect(body).toContain(`This repo still names project ${PROJECT}`);
    expect(body).toContain(`version: 1\nproject: ${PROJECT}`);
  });

  it('blames the URL, not the project, on a 404 from /projects', async () => {
    const body = bodyOf(
      await runProjects(
        {},
        projectsDeps({
          createClient: () =>
            clientFailing({ ok: false, reason: 'http', status: 404, detail: 'Not Found' }),
        }),
      ),
    );

    expect(body).toContain('missing its /mentor suffix');
  });

  it('degrades a drifted body instead of inventing a project list', async () => {
    const body = bodyOf(
      await runProjects(
        {},
        projectsDeps({
          createClient: () => clientReturning([{ id: PROJECT, rule_count: 'many' }]),
        }),
      ),
    );

    expect(body).toContain('Schema drift');
    expect(body).toContain('projects listing');
    expect(body).toContain('/plugin update axtar');
  });

  it('rejects an argument, because there is no project to pass', async () => {
    const body = bodyOf(await runProjects({ project: OTHER_PROJECT }, projectsDeps()));

    expect(body).toContain('arguments it cannot use');
    expect(fetched).toEqual([]);
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

/**
 * The marker the advisory turn-end reminder reads (`hooks/check-reminder.ts`).
 *
 * It says one thing — "this tree was checked" — so it may only be written when
 * that is true: a parsed response carrying a `check_id`. A refusal, an outage
 * and a drifted body all judged nothing, and a spec check judged a plan rather
 * than the tree; stamping on any of those would silence the reminder for a
 * change nobody looked at.
 */
describe('the checked marker', () => {
  it('stamps the work tree after a successful diff check', async () => {
    await runCheckDiff({}, deps());

    expect(marked).toEqual([PACKET.repoRoot]);
  });

  it('stamps the work tree after a successful scan', async () => {
    await runCheckScan(
      { paths: ['src/billing/**'] },
      deps({ createClient: () => clientReturning(SCAN_BODY) }),
    );

    expect(marked).toEqual([repoDir]);
  });

  it('does not stamp after a spec check — a spec proves nothing about the tree', async () => {
    await runCheckSpec(
      { spec: '# plan' },
      deps({ createClient: () => clientReturning(SPEC_BODY) }),
    );

    expect(marked).toEqual([]);
  });

  it('does not stamp a refusal', async () => {
    rmSync(join(repoDir, '.axtar'), { recursive: true, force: true });

    await runCheckDiff({}, deps());

    expect(marked).toEqual([]);
  });

  it('does not stamp a producer failure', async () => {
    await runCheckDiff(
      {},
      deps({ produce: async () => ({ ok: false, reason: 'no_base_ref', detail: 'nothing' }) }),
    );

    expect(marked).toEqual([]);
  });

  it('does not stamp when the platform could not answer', async () => {
    await runCheckDiff(
      {},
      deps({
        createClient: () =>
          clientFailing({ ok: false, reason: 'http', status: 500, detail: 'boom' }),
      }),
    );

    expect(marked).toEqual([]);
  });

  it('does not stamp a drifted response — nothing parsed, nothing checked', async () => {
    await runCheckDiff(
      {},
      deps({ createClient: () => clientReturning({ ...DIFF_BODY, breaches: 'now a string' }) }),
    );

    expect(marked).toEqual([]);
  });
});

describe('the server itself', () => {
  it('registers the four tools, the checks carrying the receipt instruction', async () => {
    const server = createServer(deps());
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'axtar_check_diff',
      'axtar_check_scan',
      'axtar_check_spec',
      'axtar_projects',
    ]);
    for (const tool of listed.tools.filter((t) => t.name.startsWith('axtar_check_'))) {
      expect(tool.description).toContain('receipt block');
      expect(tool.inputSchema.properties).toHaveProperty('ref');
    }
    await client.close();
    await server.close();
  });

  it('describes axtar_projects as the binding tool, and gives it no arguments', async () => {
    const server = createServer(deps());
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const projects = (await client.listTools()).tools.find((t) => t.name === 'axtar_projects');

    expect(projects?.description).toContain('.axtar/config.yml');
    expect(projects?.description).toContain('It reads; it never selects.');
    expect(projects?.inputSchema.properties ?? {}).toEqual({});
    await client.close();
    await server.close();
  });

  it('runs axtar_projects end to end over the transport', async () => {
    const server = createServer(deps({ createClient: () => clientReturning(PROJECTS_BODY) }));
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'axtar_projects', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('Refunds Service');
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

  it('publishes paths as a required argument on axtar_check_scan', async () => {
    const server = createServer(deps());
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const scan = (await client.listTools()).tools.find((t) => t.name === 'axtar_check_scan');

    expect(scan?.inputSchema.properties).toHaveProperty('paths');
    expect(scan?.inputSchema.required).toEqual(['paths']);
    await client.close();
    await server.close();
  });

  it('is the server the manifests point at', () => {
    expect(SERVER_NAME).toBe('axtar');
    expect(CHECK_DIFF_DESCRIPTION).toContain('Pass NO diff and NO file contents');
    expect(CHECK_SCAN_DESCRIPTION).toContain('Check EXISTING code');
    expect(CHECK_SCAN_DESCRIPTION).toContain('Use axtar_check_diff for a change');
    expect(CHECK_SCAN_DESCRIPTION).toContain('not the whole repo');
    expect(PROJECTS_DESCRIPTION).toContain('It needs no binding itself');
  });
});
