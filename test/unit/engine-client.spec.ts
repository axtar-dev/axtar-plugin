import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createEngineClient } from '../../src/shared/engine/client.js';
import type { EngineConfig } from '../../src/shared/engine/config.js';

const config: EngineConfig = {
  baseUrl: 'https://app.axtar.dev/mentor',
  apiKey: 'axtar_pk_test',
  timeoutMs: 50,
};

const Verdict = z.object({ verdict: z.string() });

const originalFetch = globalThis.fetch;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('engine client', () => {
  it('posts JSON to baseUrl + path with the bearer key and parses the response', async () => {
    const seen = stubFetch(
      async () =>
        new Response(JSON.stringify({ verdict: 'clean' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await createEngineClient(config).post(
      '/checks/diff',
      { project: 'p1' },
      Verdict,
    );

    expect(result).toEqual({ ok: true, value: { verdict: 'clean' } });
    const call = seen.calls[0];
    expect(call?.url).toBe('https://app.axtar.dev/mentor/checks/diff');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer axtar_pk_test',
      'content-type': 'application/json',
    });
    expect(call?.init.body).toBe(JSON.stringify({ project: 'p1' }));
  });

  it('surfaces the status and the FastAPI detail on a non-2xx', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ detail: 'project not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await createEngineClient(config).post('/checks/diff', {}, Verdict);

    expect(result).toEqual({
      ok: false,
      reason: 'http',
      status: 404,
      detail: 'project not found',
    });
  });

  it('falls back to the raw body when an error is not FastAPI-shaped', async () => {
    stubFetch(async () => new Response('upstream boom', { status: 502 }));

    const result = await createEngineClient(config).post('/checks/spec', {}, Verdict);

    expect(result).toMatchObject({ ok: false, reason: 'http', status: 502 });
    if (result.ok || result.reason !== 'http') throw new Error('expected an http failure');
    expect(result.detail).toBe('upstream boom');
  });

  it('reports invalid_body when the response does not match the schema', async () => {
    stubFetch(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));

    const result = await createEngineClient(config).post('/checks/diff', {}, Verdict);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_body' });
  });

  it('reports invalid_body when the response is not JSON at all', async () => {
    stubFetch(async () => new Response('<html>gateway</html>', { status: 200 }));

    const result = await createEngineClient(config).post('/checks/diff', {}, Verdict);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_body' });
  });

  it('reports network failures instead of throwing — the agent surface fails open', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await createEngineClient(config).post('/checks/diff', {}, Verdict);

    expect(result).toEqual({ ok: false, reason: 'network', detail: 'ECONNREFUSED' });
  });

  it('aborts and reports a timeout once the budget is spent', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const result = await createEngineClient({ ...config, timeoutMs: 10 }).post(
      '/checks/diff',
      {},
      Verdict,
    );

    expect(result).toEqual({ ok: false, reason: 'timeout', detail: '>10ms' });
  });
});
