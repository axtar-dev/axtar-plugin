import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEngineClient } from '../../src/shared/engine/client.js';

const config = { baseUrl: 'http://127.0.0.1:9999', timeoutMs: 50 };

const PROJECT = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Demo',
  repo_full_name: 'octocat/demo',
  rule_count: 2,
};

describe('engine client — projects + project-scoped rules', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('listRules() scopes to a project via ?project_id when given', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient(config);
    await client.listRules('abc 123');
    expect(seenUrl).toBe('http://127.0.0.1:9999/rules?project_id=abc%20123');
  });

  it('listRules() hits bare /rules when no project given', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient(config);
    await client.listRules();
    expect(seenUrl).toBe('http://127.0.0.1:9999/rules');
  });

  it('listProjects() parses the summary list', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify([PROJECT]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient(config);
    const r = await client.listProjects();
    expect(seenUrl).toBe('http://127.0.0.1:9999/projects');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.name).toBe('Demo');
      expect(r.value[0]?.rule_count).toBe(2);
    }
  });

  it('listProjects() returns reason=http on 401', async () => {
    globalThis.fetch = (async () => new Response('no', { status: 401 })) as typeof fetch;
    const client = createEngineClient(config);
    const r = await client.listProjects();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('http');
      expect(r.detail.startsWith('401')).toBe(true);
    }
  });
});
