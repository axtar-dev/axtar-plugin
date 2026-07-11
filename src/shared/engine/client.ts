/**
 * Engine HTTP client. Fail-soft on every internal error: timeout, non-2xx,
 * Zod-invalid response, network error. Returns a discriminated result so
 * callers can decide between "engine spoke" and "engine didn't" without
 * exception handling on the hot path.
 *
 * Per non-negotiable #4: never block Claude Code on an internal failure.
 */

import {
  BypassRequestSchema,
  BypassResponseSchema,
  ConsultRequestSchema,
  ConsultResponseSchema,
  EvaluateResponseSchema,
  GateRequestSchema,
  GateResponseSchema,
  PolicyResponseSchema,
  PreToolUseRequestSchema,
  ProjectSummaryListSchema,
  RuleSummaryListSchema,
  SessionSummaryResponseSchema,
  type BypassRequest,
  type BypassResponse,
  type ConsultRequest,
  type ConsultResponse,
  type EvaluateResponse,
  type GateRequest,
  type GateResponse,
  type PolicyResponse,
  type PreToolUseRequest,
  type ProjectSummary,
  type RuleSummary,
  type SessionSummaryResponse,
} from '../wire/schemas.js';
import type { EngineConfig } from './config.js';

export type EngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' | 'network' | 'http' | 'invalid_body'; detail: string };

export interface EngineClient {
  evaluate(req: PreToolUseRequest): Promise<EngineResult<EvaluateResponse>>;
  /**
   * List the org's rules. When `projectId` is given, the platform scopes the
   * listing to that project's rule pool (the hook passes the repo's selected
   * project so only its rules — plus the org constitution, merged server-side
   * — apply).
   */
  listRules(projectId?: string): Promise<EngineResult<RuleSummary[]>>;
  /** List the org's projects so a developer can bind this repo to one. */
  listProjects(): Promise<EngineResult<ProjectSummary[]>>;
  /**
   * Mentor gate — the cheap pre-check deciding whether an edit must pause for
   * a consult. POSTs `/gate`.
   */
  gate(req: GateRequest): Promise<EngineResult<GateResponse>>;
  /** Mentor consult — the richer mentor exchange. POSTs `/consult`. */
  consult(req: ConsultRequest): Promise<EngineResult<ConsultResponse>>;
  /**
   * Record a developer's explicit override of a gate that demanded a consult.
   * POSTs `/bypass`; resolves to the persisted record's `{ id }`.
   */
  bypass(req: BypassRequest): Promise<EngineResult<BypassResponse>>;
  /**
   * Resolve the autonomy rung for this repo's org/project (D-063). The hook
   * passes the repo's bound project so policy can scope per-project later;
   * best-effort — callers treat any failure as Rung 1.
   */
  policy(projectId?: string): Promise<EngineResult<PolicyResponse>>;
  /** Fetch the read-only session summary (D-064) — the PR's judgment-calls source. */
  summary(sessionId: string): Promise<EngineResult<SessionSummaryResponse>>;
}

export function createEngineClient(config: EngineConfig): EngineClient {
  return {
    evaluate: (req) => post(config, '/evaluate', req, EvaluateResponseSchema),
    listRules: (projectId) =>
      get(
        config,
        projectId ? `/rules?project_id=${encodeURIComponent(projectId)}` : '/rules',
        RuleSummaryListSchema,
      ),
    listProjects: () => get(config, '/projects', ProjectSummaryListSchema),
    gate: (req) => postJson(config, '/gate', GateRequestSchema, req, GateResponseSchema),
    consult: (req) =>
      postJson(config, '/consult', ConsultRequestSchema, req, ConsultResponseSchema),
    bypass: (req) => postJson(config, '/bypass', BypassRequestSchema, req, BypassResponseSchema),
    policy: (projectId) =>
      get(
        config,
        projectId ? `/policy?project_id=${encodeURIComponent(projectId)}` : '/policy',
        PolicyResponseSchema,
      ),
    summary: (sessionId) =>
      get(
        config,
        `/sessions/${encodeURIComponent(sessionId)}/summary`,
        SessionSummaryResponseSchema,
      ),
  };
}

/**
 * Generic JSON POST. Pre-validates the body against `reqSchema` (returning
 * `invalid_body` exactly like `post` does for `PreToolUseRequest`), then
 * parses the response with `resSchema`. Used by the mentor routes whose
 * bodies are not `PreToolUseRequest`.
 */
async function postJson<Req, Res>(
  config: EngineConfig,
  path: string,
  reqSchema: {
    safeParse: (
      data: unknown,
    ) => { success: true; data: Req } | { success: false; error: { message: string } };
  },
  body: Req,
  resSchema: { parse: (data: unknown) => Res },
): Promise<EngineResult<Res>> {
  const validated = reqSchema.safeParse(body);
  if (!validated.success) {
    return { ok: false, reason: 'invalid_body', detail: validated.error.message };
  }
  return request(config, path, resSchema, {
    method: 'POST',
    headers: authHeaders(config, { 'content-type': 'application/json' }),
    body: JSON.stringify(validated.data),
  });
}

async function post<T>(
  config: EngineConfig,
  path: string,
  body: PreToolUseRequest,
  schema: { parse: (data: unknown) => T },
): Promise<EngineResult<T>> {
  const validated = PreToolUseRequestSchema.safeParse(body);
  if (!validated.success) {
    return { ok: false, reason: 'invalid_body', detail: validated.error.message };
  }
  return request(config, path, schema, {
    method: 'POST',
    headers: authHeaders(config, { 'content-type': 'application/json' }),
    body: JSON.stringify(validated.data),
  });
}

async function get<T>(
  config: EngineConfig,
  path: string,
  schema: { parse: (data: unknown) => T },
): Promise<EngineResult<T>> {
  return request(config, path, schema, {
    method: 'GET',
    headers: authHeaders(config),
  });
}

/**
 * Attach `Authorization: Bearer <apiKey>` when the caller configured one.
 * Backward-compatible: when no key is set, no header is sent and the
 * legacy standalone engine (which never required auth) still accepts the
 * request. The embedded platform `/evaluate` requires the header.
 */
function authHeaders(
  config: EngineConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  if (config.apiKey) {
    return { ...extra, authorization: `Bearer ${config.apiKey}` };
  }
  return extra;
}

async function request<T>(
  config: EngineConfig,
  path: string,
  schema: { parse: (data: unknown) => T },
  init: RequestInit,
): Promise<EngineResult<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}${path}`, { ...init, signal: ac.signal });
    if (!res.ok) {
      return {
        ok: false,
        reason: 'http',
        detail: `${res.status} ${res.statusText}`,
      };
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      return {
        ok: false,
        reason: 'invalid_body',
        detail: err instanceof Error ? err.message : 'JSON parse failed',
      };
    }
    try {
      return { ok: true, value: schema.parse(raw) };
    } catch (err) {
      return {
        ok: false,
        reason: 'invalid_body',
        detail: err instanceof Error ? err.message : 'schema validation failed',
      };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `>${config.timeoutMs}ms` };
    }
    return {
      ok: false,
      reason: 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
