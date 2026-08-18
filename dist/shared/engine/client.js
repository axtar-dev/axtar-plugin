/**
 * The HTTP seam to the platform's `/mentor` sub-app.
 *
 * Two methods, one per direction the plugin actually needs. A typed JSON POST
 * carries the two checks (`/checks/diff`, `/checks/spec`, spec §9) — both the
 * same shape: send a producer-built packet, parse a judgment. A typed JSON GET
 * carries the one read (`/projects`), which `axtar_projects` lists so a
 * developer can *author* the binding; the platform stores no selection, so
 * there is nothing here that writes one. The response parser is passed in by
 * the caller (a zod schema), which keeps the wire contract in one place:
 * **zod is the single source of truth for the wire**, so a field the platform
 * renamed fails here, loudly, instead of arriving as `undefined` three layers
 * down.
 *
 * **Nothing throws.** The agent surface fails open (spec §12: "a hiccup must
 * never block a developer mid-flow"), so every failure — timeout, non-2xx,
 * unparseable body, DNS — comes back as a discriminated result the caller
 * renders as text. `status` rides on the `http` variant because the meaningful
 * ones are actionable: 401 is a bad key, 404 is a project id that does not
 * belong to this key, 409 is an org with no usable LLM provider.
 */
export function createEngineClient(config) {
    const authorization = `Bearer ${config.apiKey}`;
    return {
        post: (path, body, schema) => request(config, path, schema, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization,
            },
            body: JSON.stringify(body),
        }),
        get: (path, schema) => request(config, path, schema, {
            method: 'GET',
            headers: { authorization },
        }),
    };
}
/**
 * FastAPI answers an error with `{"detail": "..."}`; that string is written for
 * the caller (which project, which provider to configure) and is worth far more
 * than the status text. Fall back to the raw body, then to the status line.
 */
async function failureDetail(res) {
    let raw = '';
    try {
        raw = (await res.text()).trim();
    }
    catch {
        raw = '';
    }
    if (raw.length === 0)
        return `${res.status} ${res.statusText}`.trim();
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && 'detail' in parsed) {
            const detail = parsed.detail;
            if (typeof detail === 'string' && detail.trim().length > 0)
                return detail;
            return JSON.stringify(detail);
        }
    }
    catch {
        // Not JSON — the raw body is the best detail available.
    }
    return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}
async function request(config, path, schema, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.timeoutMs);
    try {
        const res = await fetch(`${config.baseUrl}${path}`, { ...init, signal: ac.signal });
        if (!res.ok) {
            return { ok: false, reason: 'http', status: res.status, detail: await failureDetail(res) };
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