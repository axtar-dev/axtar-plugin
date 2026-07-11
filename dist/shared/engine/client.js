/**
 * Engine HTTP client. Fail-soft on every internal error: timeout, non-2xx,
 * Zod-invalid response, network error. Returns a discriminated result so
 * callers can decide between "engine spoke" and "engine didn't" without
 * exception handling on the hot path.
 *
 * Per non-negotiable #4: never block Claude Code on an internal failure.
 */
import { BypassRequestSchema, BypassResponseSchema, ConsultRequestSchema, ConsultResponseSchema, EvaluateResponseSchema, GateRequestSchema, GateResponseSchema, PolicyResponseSchema, PreToolUseRequestSchema, ProjectSummaryListSchema, RuleSummaryListSchema, SessionSummaryResponseSchema, } from '../wire/schemas.js';
export function createEngineClient(config) {
    return {
        evaluate: (req) => post(config, '/evaluate', req, EvaluateResponseSchema),
        listRules: (projectId) => get(config, projectId ? `/rules?project_id=${encodeURIComponent(projectId)}` : '/rules', RuleSummaryListSchema),
        listProjects: () => get(config, '/projects', ProjectSummaryListSchema),
        gate: (req) => postJson(config, '/gate', GateRequestSchema, req, GateResponseSchema),
        consult: (req) => postJson(config, '/consult', ConsultRequestSchema, req, ConsultResponseSchema),
        bypass: (req) => postJson(config, '/bypass', BypassRequestSchema, req, BypassResponseSchema),
        policy: (projectId) => get(config, projectId ? `/policy?project_id=${encodeURIComponent(projectId)}` : '/policy', PolicyResponseSchema),
        summary: (sessionId) => get(config, `/sessions/${encodeURIComponent(sessionId)}/summary`, SessionSummaryResponseSchema),
    };
}
/**
 * Generic JSON POST. Pre-validates the body against `reqSchema` (returning
 * `invalid_body` exactly like `post` does for `PreToolUseRequest`), then
 * parses the response with `resSchema`. Used by the mentor routes whose
 * bodies are not `PreToolUseRequest`.
 */
async function postJson(config, path, reqSchema, body, resSchema) {
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
async function post(config, path, body, schema) {
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
async function get(config, path, schema) {
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
function authHeaders(config, extra = {}) {
    if (config.apiKey) {
        return { ...extra, authorization: `Bearer ${config.apiKey}` };
    }
    return extra;
}
async function request(config, path, schema, init) {
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
        let raw;
        try {
            raw = await res.json();
        }
        catch (err) {
            return {
                ok: false,
                reason: 'invalid_body',
                detail: err instanceof Error ? err.message : 'JSON parse failed',
            };
        }
        try {
            return { ok: true, value: schema.parse(raw) };
        }
        catch (err) {
            return {
                ok: false,
                reason: 'invalid_body',
                detail: err instanceof Error ? err.message : 'schema validation failed',
            };
        }
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            return { ok: false, reason: 'timeout', detail: `>${config.timeoutMs}ms` };
        }
        return {
            ok: false,
            reason: 'network',
            detail: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=client.js.map