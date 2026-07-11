import { describe, it, expect, afterEach } from 'vitest';
import {
  handleConsult,
  handleSessionSummary,
  CONSULT_INPUT_SHAPE,
  SESSION_SUMMARY_INPUT_SHAPE,
  consultEngineConfig,
} from '../../src/mcp/consult-server.js';
import type { EngineClient } from '../../src/shared/engine/client.js';
import type { ConsultRequest } from '../../src/shared/wire/schemas.js';
import { z } from 'zod';

type ConsultFn = EngineClient['consult'];

describe('consult MCP tool handler', () => {
  it('relays args to engine consult and returns the result as text', async () => {
    const captured: ConsultRequest[] = [];
    const consult: ConsultFn = async (req) => {
      captured.push(req);
      return {
        ok: true,
        value: {
          answer: 'use the service layer',
          verdict: 'approve',
          rationale: 'r',
          approved_files: ['/x.java'],
          follow_up_questions: [],
        },
      };
    };
    const res = await handleConsult(
      { consult },
      {
        session_id: 's1',
        files: ['/x.java'],
        question: 'where?',
        proposed_edit: 'class X{}',
      },
    );
    // relays verbatim — no defaulting / no mutation of session_id or files
    expect(captured[0]?.session_id).toBe('s1');
    expect(captured[0]?.files).toEqual(['/x.java']);
    expect(captured[0]?.question).toBe('where?');
    expect(res.content[0]?.text).toContain('approve');
  });

  it('surfaces an engine failure as text content, never throws', async () => {
    const consult: ConsultFn = async () => ({ ok: false, reason: 'timeout', detail: 'x' });
    const res = await handleConsult({ consult }, { session_id: 's1', files: ['/x.java'] });
    expect(res.content[0]?.text.toLowerCase()).toContain('timeout');
  });

  it('forwards the bound project_id (repo binding, not an agent arg) when given', async () => {
    const captured: ConsultRequest[] = [];
    const consult: ConsultFn = async (req) => {
      captured.push(req);
      return {
        ok: true,
        value: {
          answer: 'a',
          verdict: 'approve',
          rationale: 'r',
          approved_files: ['/x.java'],
          follow_up_questions: [],
        },
      };
    };
    await handleConsult({ consult }, { session_id: 's1', files: ['/x.java'] }, 'proj-123');
    expect(captured[0]?.project_id).toBe('proj-123');
  });

  it('omits project_id entirely when the repo is unbound (no undefined on the wire)', async () => {
    const captured: ConsultRequest[] = [];
    const consult: ConsultFn = async (req) => {
      captured.push(req);
      return { ok: false, reason: 'timeout', detail: 'x' };
    };
    await handleConsult({ consult }, { session_id: 's1', files: ['/x.java'] });
    expect(captured[0] && 'project_id' in captured[0]).toBe(false);
  });

  it('does NOT default a missing session_id — the input schema requires it', () => {
    const schema = z.object(CONSULT_INPUT_SHAPE);
    expect(schema.safeParse({ files: ['/x.java'] }).success).toBe(false); // no session_id → reject
    expect(schema.safeParse({ session_id: '', files: ['/x.java'] }).success).toBe(false); // empty → reject
    expect(schema.safeParse({ session_id: 's', files: [] }).success).toBe(false); // empty files → reject
    expect(schema.safeParse({ session_id: 's', files: ['/x'] }).success).toBe(true);
  });
});

describe('consult server engine client config', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('builds its client with the consult timeout (~90s), NOT the 10s hook timeout', () => {
    // The gate's fast budget must not leak into the consultation path: the
    // mentor LLM (45s) plus the adversarial guard (45s) routinely exceed 10s.
    process.env.AXTAR_HOOK_TIMEOUT_MS = '10000';
    delete process.env.AXTAR_CONSULT_TIMEOUT_MS;
    const cfg = consultEngineConfig();
    expect(cfg.timeoutMs).toBe(90000);
    expect(cfg.timeoutMs).toBeGreaterThan(10000);
  });
});

type SummaryFn = EngineClient['summary'];

describe('session_summary MCP tool handler', () => {
  it('relays session_id to engine summary and returns the summary as text', async () => {
    const captured: string[] = [];
    const summary: SummaryFn = async (sid) => {
      captured.push(sid);
      return {
        ok: true,
        value: {
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
        },
      };
    };
    const res = await handleSessionSummary({ summary }, { session_id: 's1' });
    expect(captured[0]).toBe('s1');
    expect(res.content[0]?.text).toContain('Judgment calls');
    expect(res.content[0]?.text).toContain('wrap-and-rethrow');
  });

  it('surfaces an engine failure as text content, never throws', async () => {
    const summary: SummaryFn = async () => ({ ok: false, reason: 'timeout', detail: 'x' });
    const res = await handleSessionSummary({ summary }, { session_id: 's1' });
    expect(res.content[0]?.text.toLowerCase()).toContain('timeout');
  });

  it('requires a non-empty session_id (input schema)', () => {
    const schema = z.object(SESSION_SUMMARY_INPUT_SHAPE);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ session_id: '' }).success).toBe(false);
    expect(schema.safeParse({ session_id: 's1' }).success).toBe(true);
  });
});
