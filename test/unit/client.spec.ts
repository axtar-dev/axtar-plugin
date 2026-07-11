import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEngineClient } from '../../src/shared/engine/client.js';

const config = { baseUrl: 'http://127.0.0.1:9999', timeoutMs: 50 };

describe('engine client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns ok on a valid /evaluate response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ verdict: 'pass', violations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const client = createEngineClient(config);
    const r = await client.evaluate({
      session_id: 's',
      tool: 'Edit',
      file_path: '/x',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.verdict).toBe('pass');
    }
  });

  it('returns reason=http on 5xx', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createEngineClient(config);
    const r = await client.evaluate({
      session_id: 's',
      tool: 'Edit',
      file_path: '/x',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('http');
  });

  it('returns reason=invalid_body when response does not match schema', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ verdict: 'kaboom' }), {
        status: 200,
      })) as typeof fetch;
    const client = createEngineClient(config);
    const r = await client.evaluate({
      session_id: 's',
      tool: 'Edit',
      file_path: '/x',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_body');
  });

  it('returns reason=timeout when fetch is aborted', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch;
    const client = createEngineClient(config);
    const r = await client.evaluate({
      session_id: 's',
      tool: 'Edit',
      file_path: '/x',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });

  it('sends Authorization: Bearer when apiKey is configured', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured.headers = init?.headers;
      return new Response(JSON.stringify({ verdict: 'pass', violations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient({ ...config, apiKey: 'axtar_pk_test1234' });
    const r = await client.evaluate({
      session_id: 's',
      tool: 'Edit',
      file_path: '/x',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    expect(r.ok).toBe(true);
    const headers = captured.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer axtar_pk_test1234');
  });

  it('omits Authorization header when apiKey is not configured', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured.headers = init?.headers;
      return new Response(JSON.stringify({ verdict: 'pass', violations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient(config);
    await client.evaluate({
      session_id: 's',
      tool: 'Edit',
      file_path: '/x',
      diff: '',
      file_after: '',
      rule_set: [],
    });
    const headers = captured.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('gate() POSTs /gate with bearer auth and parses GateResponse', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.headers = init?.headers;
      captured.body = init?.body;
      captured.method = init?.method;
      return new Response(
        JSON.stringify({
          cleared: false,
          triggered_rule_ids: ['AXT-ARC-1'],
          reason: 'consult_required',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = createEngineClient({ ...config, apiKey: 'axtar_pk_test1234' });
    const r = await client.gate({ session_id: 's', file_path: '/x', rule_set: ['AXT-ARC-1'] });

    expect(captured.url).toBe('http://127.0.0.1:9999/gate');
    expect(captured.method).toBe('POST');
    const headers = captured.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer axtar_pk_test1234');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cleared).toBe(false);
      expect(r.value.triggered_rule_ids).toEqual(['AXT-ARC-1']);
      expect(r.value.reason).toBe('consult_required');
    }
  });

  it('gate() surfaces a malformed response as invalid_body', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ cleared: 'nope' }), {
        status: 200,
      })) as typeof fetch;
    const client = createEngineClient(config);
    const r = await client.gate({ session_id: 's', file_path: '/x', rule_set: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_body');
  });

  it('consult() POSTs /consult and parses ConsultResponse', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.headers = init?.headers;
      return new Response(
        JSON.stringify({
          answer: 'looks fine',
          verdict: 'approve',
          rationale: 'no rule violated',
          approved_files: ['/x'],
          follow_up_questions: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = createEngineClient({ ...config, apiKey: 'axtar_pk_test1234' });
    const r = await client.consult({ session_id: 's', files: ['/x'], question: 'ok?' });

    expect(captured.url).toBe('http://127.0.0.1:9999/consult');
    const headers = captured.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer axtar_pk_test1234');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.verdict).toBe('approve');
      expect(r.value.approved_files).toEqual(['/x']);
    }
  });

  it('bypass() POSTs /bypass and parses {id}', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.headers = init?.headers;
      return new Response(JSON.stringify({ id: 'bypass-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient({ ...config, apiKey: 'axtar_pk_test1234' });
    const r = await client.bypass({
      session_id: 's',
      file_path: '/x',
      triggered_rule_ids: ['AXT-ARC-1'],
      reason: 'override',
    });

    expect(captured.url).toBe('http://127.0.0.1:9999/bypass');
    const headers = captured.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer axtar_pk_test1234');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('bypass-123');
    }
  });

  it('policy() GETs /policy with project_id and parses PolicyResponse', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.method = init?.method;
      return new Response(JSON.stringify({ autonomy_rung: 'rung2_gate_certified' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createEngineClient({ ...config, apiKey: 'axtar_pk_test1234' });
    const r = await client.policy('proj-1');

    expect(captured.url).toBe('http://127.0.0.1:9999/policy?project_id=proj-1');
    expect(captured.method).toBe('GET');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.autonomy_rung).toBe('rung2_gate_certified');
  });

  it('policy() omits project_id when the repo is unbound', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string) => {
      captured.url = url;
      return new Response(JSON.stringify({ autonomy_rung: 'rung1_autonomous_fix' }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = createEngineClient(config);
    await client.policy();
    expect(captured.url).toBe('http://127.0.0.1:9999/policy');
  });

  it('summary() GETs /sessions/{id}/summary and parses the summary (passthrough)', async () => {
    const captured: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string) => {
      captured.url = url;
      return new Response(
        JSON.stringify({
          session_id: 's1',
          narrative_markdown:
            '## Judgment calls (rule-permitted, not rule-dictated)\n**wrap-and-rethrow**',
          judgment_calls: [
            {
              files: ['/x.java'],
              decision: 'wrap-and-rethrow',
              alternatives: 'result-type',
              why_unconstrained: 'corpus silent',
            },
          ],
          files_touched: ['/x.java'], // extra server field → tolerated (non-strict)
          corpus_drift: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = createEngineClient({ ...config, apiKey: 'axtar_pk_test1234' });
    const r = await client.summary('s1');
    expect(captured.url).toBe('http://127.0.0.1:9999/sessions/s1/summary');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.narrative_markdown).toContain('Judgment calls');
      expect(r.value.judgment_calls[0]?.decision).toBe('wrap-and-rethrow');
      expect((r.value as Record<string, unknown>).files_touched).toEqual(['/x.java']);
    }
  });

  it('listRules parses /rules response', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            id: 'AXT-JAVA-042',
            name: 'money',
            altitude: 'implementation',
            severity: 'blocking',
            language: 'java',
            paths: [],
          },
        ]),
        { status: 200 },
      )) as typeof fetch;

    const client = createEngineClient(config);
    const r = await client.listRules();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.id).toBe('AXT-JAVA-042');
    }
  });
});
