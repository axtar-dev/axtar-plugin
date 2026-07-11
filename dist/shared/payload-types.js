/**
 * Host-neutral payload-side types the shared runner consumes.
 *
 * Each host's `assemble.ts` implements `AssembleFn` and exports a
 * `parseInput` (typed as `ParseInputFn`). Both are injected into the
 * runner via `RunOptions`, so the runner depends only on these shared
 * types — never on a concrete host module.
 *
 * Extracted from `claude-code/assemble.ts` in Step 11.5.2 to close the
 * shared/ → hosts/claude-code/ upward imports that 11.5.1b introduced.
 * Host-specific `assemble.ts` files may *widen* `AssembleOutcome` for
 * their own tool-discriminated needs (e.g. claude-code's `tool: 'Edit'
 * | 'Write'`); the shared shape carries only what the runner uses.
 */
// ───────────────────────────────────────────────────────────────────────────
// Mentor gate trigger altitudes. The PreToolUse gate fires for any rule at one
// of these altitudes that is *applicable* to an edit — regardless of its
// severity (the gate asks "was it discussed?", not "is it violated?"). The Pre
// prefilter passes this set to `filterRules` so high-altitude rules survive the
// severity filter and reach /evaluate, where the server computes
// `consult_required`. Their LLM detection still stays Post-only: the server
// defers it on the gate-check call.
//
// Single-engine product (D-046): there is no longer a PRE_ENGINES/POST_ENGINES
// partition to survive — this carve-out is now the SOLE mechanism forwarding
// gate rules on the Pre path (D-049).
//
// MUST mirror the server's `HIGH_ALTITUDES` (api/app/mentor/trigger.py). Drift
// between the two is a silent under-gating bug (a high-altitude rule the plugin
// forwards but the server doesn't trigger on, or vice-versa) — same wire-drift
// discipline as the contract schemas.
// ───────────────────────────────────────────────────────────────────────────
export const HIGH_ALTITUDES = new Set([
    'architectural',
    'design',
    'product-business',
]);
//# sourceMappingURL=payload-types.js.map