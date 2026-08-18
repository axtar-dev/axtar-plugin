/**
 * How this machine reaches the Axtar platform.
 *
 * Two environment variables, both required — there is no local default and no
 * silent fallback:
 *
 * - `AXTAR_ENGINE_URL` — the platform's `/mentor` base URL, e.g.
 *   `https://app.axtar.dev/mentor`. The check routes are appended to it
 *   (`/checks/diff`, `/checks/spec`).
 * - `AXTAR_API_KEY` — an `axtar_pk_…` token from the portal's Settings → API
 *   keys. Sent as `Authorization: Bearer …`; every `/mentor` route authenticates
 *   with it, and the key is what scopes a check to an organization.
 *
 * **A missing value is reported, never guessed.** An unset URL quietly pointing
 * at localhost would turn "the platform is not configured" into a network error
 * a developer has to decode, so `loadEngineConfig` returns which variables are
 * missing and the caller refuses the tool call with setup instructions.
 *
 * The one tunable knob is the request budget: checks are **synchronous** and the
 * platform caps a check at 300 s of wall clock, returning partials with
 * `dropped[]` populated rather than exceeding it (spec §15). The client budget
 * therefore sits just above that cap — giving up earlier would throw away an
 * answer the platform is about to send.
 */
/** The env vars this module reads. Named so callers can print them verbatim. */
export const ENGINE_URL_ENV = 'AXTAR_ENGINE_URL';
export const API_KEY_ENV = 'AXTAR_API_KEY';
export const TIMEOUT_ENV = 'AXTAR_CHECK_TIMEOUT_MS';
/** 300 s platform cap (spec §15) + headroom for the round trip. */
export const DEFAULT_TIMEOUT_MS = 310_000;
function readString(env, name) {
    const raw = env[name]?.trim();
    return raw && raw.length > 0 ? raw : null;
}
function readTimeoutMs(env) {
    const raw = readString(env, TIMEOUT_ENV);
    if (raw === null)
        return DEFAULT_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
/**
 * Read the connection settings, or report which variables are missing.
 *
 * `env` is injectable so this stays a pure function under test; production
 * callers pass nothing and get `process.env`.
 */
export function loadEngineConfig(env = process.env) {
    const baseUrl = readString(env, ENGINE_URL_ENV);
    const apiKey = readString(env, API_KEY_ENV);
    const missing = [];
    if (baseUrl === null)
        missing.push(ENGINE_URL_ENV);
    if (apiKey === null)
        missing.push(API_KEY_ENV);
    if (baseUrl === null || apiKey === null) {
        return { ok: false, missing };
    }
    return {
        ok: true,
        config: {
            baseUrl: baseUrl.replace(/\/+$/, ''),
            apiKey,
            timeoutMs: readTimeoutMs(env),
        },
    };
}
/**
 * What to tell the agent when the platform is not configured — the setup
 * instructions the tools refuse with (spec §15).
 */
export function setupInstructions(missing) {
    return (`Axtar is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        `Run /axtar:setup, or set ${ENGINE_URL_ENV} to your platform's /mentor base URL ` +
        `and ${API_KEY_ENV} to an axtar_pk_… key from the portal's Settings → API keys.`);
}
//# sourceMappingURL=config.js.map