/**
 * `OutputAdapter` — host-neutral seam between the shared runner and each
 * host's stream/envelope rendering (D-039).
 *
 * The adapter is a *pure function* family: it takes a host-neutral
 * `EvaluateResponse` and a `RenderContext` and returns a host-neutral
 * `HookEmission` descriptor (what stream content + which exit code). The
 * shared runner performs the actual emit (write streams, exit) and stays
 * host-blind.
 *
 * Method surface:
 *   - `render(response, context)` — the verdict-rendering path.
 *   - `renderEngineUnreachable(detail)` — the degraded path when the
 *     engine is not reachable. Each host renders this differently (Claude
 *     Code uses stderr + exit 0; another host might use a JSON envelope),
 *     so it lives behind the same adapter seam as `render`. D-039's
 *     interface spec named `render` only; this is the natural extension
 *     for the degraded path that `verdict.ts` already owned (as the
 *     `renderEngineUnreachable` free function before the wrap).
 */
export {};
//# sourceMappingURL=adapter.js.map