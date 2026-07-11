/**
 * Engine connection settings (D-022).
 *
 * - `AXTAR_ENGINE_URL`     — defaults to `http://127.0.0.1:8765`.
 * - `AXTAR_HOOK_TIMEOUT_MS` — inner HTTP timeout in ms; default 10000 (10s).
 * - `AXTAR_API_KEY`         — optional. When set, the engine client sends
 *   `Authorization: Bearer <key>` on every request. Required to talk to
 *   the embedded platform `/evaluate` (which auths every request); the
 *   legacy standalone engine ignores the header so the same plugin binary
 *   works against both during migration.
 *
 * The 10 s default accommodates LLM-bearing `/evaluate` calls on
 * PostToolUse (per D-035 Path D's ≤100 / 100–300-line tiers, plus
 * aggregation + network overhead). The original 600 ms default was sized
 * for the Semgrep-only PreToolUse path and was unrevisited when LLM rules
 * shipped on Post in Step 10 — the rehearsal-#1 retry surfaced that the
 * 600 ms ceiling fired before Sonnet's response arrived, so the engine
 * verdict never reached the agent. PreToolUse paths remain Semgrep-only
 * in Phase 4 and complete in well under one second, so the same value
 * applies cleanly to both hooks today.
 *
 * Operationally this is a **Post-shaped budget**: PreToolUse is also
 * bounded by Claude Code's `hooks.json` outer cap (`timeout: 2` seconds),
 * which fires before this inner 10 s timeout could ever bite — so
 * LLM-on-Pre in Phase 5+ requires revisiting `hooks.json` first, before
 * this knob matters for Pre. The outer cap is the catastrophic safety
 * net; this inner timeout is the per-request SLA. See D-035 ("Note on
 * the asymmetry mechanism") for the full reasoning.
 *
 * ## Two-tier latency: the consult path is NOT the gate path
 *
 * `AXTAR_HOOK_TIMEOUT_MS` above is the *gate/evaluate* budget — fast by design
 * (D-035 fast tier). The Mentor **consultation** is the opposite: quality-first.
 * A single consult drives the mentor LLM (`mentor_llm_timeout_s = 45`) and, on
 * approve, a second adversarial-guard LLM call (another ~45 s). The 10 s hook
 * budget gives up long before that returns — three consult attempts timed out
 * >10 s in the live agent loop. So the consult server reads its OWN knob:
 *
 * - `AXTAR_CONSULT_TIMEOUT_MS` — consult HTTP timeout in ms; default 90000
 *   (90 s = mentor 45 s + guard 45 s, with headroom). Read ONLY by the bundled
 *   consult MCP server via {@link loadConsultConfig}; the gate/evaluate hooks
 *   stay on the 10 s budget above. This is the wire/config expression of the
 *   spec's two-tier design — see the Mentor spec's latency section.
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const DEFAULT_TIMEOUT_MS = 10000;
// Consult is quality-first: mentor LLM (45s) + adversarial guard (45s) + headroom.
const DEFAULT_CONSULT_TIMEOUT_MS = 90000;
function readPositiveIntEnv(name, fallback) {
    const raw = process.env[name]?.trim();
    if (raw && raw.length > 0) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return fallback;
}
export function loadEngineConfig() {
    const rawUrl = process.env.AXTAR_ENGINE_URL?.trim();
    const baseUrl = rawUrl && rawUrl.length > 0 ? rawUrl : DEFAULT_BASE_URL;
    const timeoutMs = readPositiveIntEnv('AXTAR_HOOK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const rawApiKey = process.env.AXTAR_API_KEY?.trim();
    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    if (rawApiKey && rawApiKey.length > 0) {
        return { baseUrl: cleanBaseUrl, timeoutMs, apiKey: rawApiKey };
    }
    return { baseUrl: cleanBaseUrl, timeoutMs };
}
/**
 * Engine config for the bundled consult MCP server. Identical to
 * {@link loadEngineConfig} (same baseUrl + apiKey) EXCEPT the timeout, which
 * comes from `AXTAR_CONSULT_TIMEOUT_MS` (default 90 s) instead of the 10 s
 * gate/hook budget. Mentor consultations are quality-first and routinely
 * outlast the hook budget; this keeps the two tiers explicit at the config
 * layer rather than letting the consult path inherit the gate's short SLA.
 */
export function loadConsultConfig() {
    const base = loadEngineConfig();
    return {
        ...base,
        timeoutMs: readPositiveIntEnv('AXTAR_CONSULT_TIMEOUT_MS', DEFAULT_CONSULT_TIMEOUT_MS),
    };
}
//# sourceMappingURL=config.js.map