/**
 * Wire-format Zod schemas — runtime validation surface for everything that
 * crosses the plugin/platform boundary.
 *
 * Source of truth is the platform's Pydantic schemas (`api/app/evaluation/
 * schema/wire.py` and `api/app/schemas/plugin/`) (D-009). Drift between
 * these schemas and the JSON Schemas committed under `contracts/wire/` is
 * detected by `test/unit/contract.spec.ts` (D-019).
 *
 * `.strict()` mirrors Pydantic's `extra="forbid"` (D-005) — unknown fields
 * are validation errors on both sides.
 */
import { z } from 'zod';
export const SeveritySchema = z.enum(['blocking', 'warning', 'suggestion']);
export const VerdictSchema = z.enum(['block', 'warn', 'pass']);
export const FoundationSchema = z
    .object({
    spec: z.string().nullable().default(null),
    rationale: z.string().nullable().default(null),
    authored_by: z.string().nullable().default(null),
    enforced_since: z.string().nullable().default(null),
})
    .strict();
export const ViolationSchema = z
    .object({
    rule_id: z.string(),
    severity: SeveritySchema,
    message: z.string(),
    foundation: FoundationSchema.nullable().default(null),
    fix_suggestion: z.string().nullable().default(null),
})
    .strict();
export const PreToolUseRequestSchema = z
    .object({
    session_id: z.string().min(1),
    tool: z.string().min(1),
    file_path: z.string().min(1),
    diff: z.string(),
    file_after: z.string(),
    // Required, no default — wire contract says clients always include it
    // (`[]` is the legitimate "no rules apply" payload).
    rule_set: z.array(z.string()),
    // The repo's BOUND project id (from `.axtar/config.json`). Additive +
    // optional: when present the server enforces exactly that project's pool;
    // omitted → org-wide scope (unbound repo / older server). Mirrors the
    // engine's `project_id: str | None`.
    project_id: z.string().optional(),
    // Pre-path gate-check signal (Mentor v1 bug fix). When true, the server
    // computes `consult_required` from applicability but SKIPS LLM detection
    // for this call — so high-altitude LLM rules can reach /evaluate on the
    // Pre path (firing the gate) without spending the LLM round-trip there
    // (detection stays Post-only; <100ms Pre budget preserved). Additive +
    // defaulted, mirroring the `consult_required` boolean: older servers
    // ignore it, older plugins omit it.
    gate_check: z.boolean().default(false),
})
    .strict();
export const EvaluateResponseSchema = z
    .object({
    verdict: VerdictSchema,
    // Required, no default — engine always returns the field, possibly empty.
    violations: z.array(ViolationSchema),
    // Additive, optional, defaulted — mirrors the engine's Pydantic
    // `consult_required: bool = False` (Phase C). `.default(false)` makes
    // the field optional on input (older engines omit it) and present on
    // output; `.strict()` still rejects *other* unknown keys.
    consult_required: z.boolean().default(false),
})
    .strict();
/**
 * Mentor interactive pillar — gate + consult wire shapes (F1).
 *
 * The gate is the cheap pre-check that decides whether an edit must pause
 * for a consult; the consult is the richer mentor exchange. Both mirror the
 * engine's Pydantic schemas and use `.strict()` (Pydantic `extra="forbid"`).
 */
export const GateRequestSchema = z
    .object({
    session_id: z.string().min(1),
    file_path: z.string().min(1),
    rule_set: z.array(z.string()),
    // Bound project id — scopes the gate to that project's pool. Additive +
    // optional (org-wide when omitted). See PreToolUseRequest.project_id.
    project_id: z.string().optional(),
})
    .strict();
export const GateResponseSchema = z
    .object({
    cleared: z.boolean(),
    triggered_rule_ids: z.array(z.string()),
    reason: z.string(),
    // Director fields (D-052): additive + optional so the schema tolerates both
    // a response that omits them (old server) and one that includes them (new).
    guidance: z.string().nullish(),
    escalate: z.boolean().optional(),
    attempt: z.number().int().nullish(),
})
    .strict();
export const ConsultRequestSchema = z
    .object({
    session_id: z.string().min(1),
    files: z.array(z.string()).min(1),
    question: z.string().optional(),
    proposed_edit: z.string().optional(),
    plan: z.string().optional(),
    file_context: z.string().optional(),
    // Bound project id — scopes the consult's triggered-rule derivation to that
    // project's pool. Additive + optional. See PreToolUseRequest.project_id.
    project_id: z.string().optional(),
})
    .strict();
export const UndeterminedChoiceSchema = z
    .object({
    decision: z.string(),
    alternatives: z.string(),
    why_unconstrained: z.string(),
})
    .strict();
export const ConsultResponseSchema = z
    .object({
    answer: z.string(),
    verdict: z.enum(['approve', 'revise', 'block']),
    rationale: z.string(),
    approved_files: z.array(z.string()),
    follow_up_questions: z.array(z.string()),
    // Determinacy fields (D-060/D-062): additive + defaulted so the schema
    // tolerates an old server (omits) and a new one (includes).
    determinacy: z.string().default('dictated'),
    underdetermined_choices: z.array(UndeterminedChoiceSchema).default([]),
})
    .strict();
export const JudgmentCallSchema = z
    .object({
    files: z.array(z.string()),
    decision: z.string(),
    alternatives: z.string(),
    why_unconstrained: z.string(),
})
    .strict();
/**
 * Session summary (D-056/D-064). Read-only, server-owned, deliberately growable:
 * the plugin forwards it to the agent and branches on NO field, so — like
 * ProjectSummary and unlike the strict evaluation shapes — this is NOT .strict().
 * It validates only the two fields the `session_summary` MCP tool relies on and
 * passes the rest through, so server-side summary growth never breaks the tool.
 */
export const SessionSummaryResponseSchema = z
    .object({
    narrative_markdown: z.string(),
    judgment_calls: z.array(JudgmentCallSchema),
})
    .passthrough();
/**
 * Mentor bypass — a developer's explicit override of a gate that demanded a
 * consult. Mirrors the engine's `BypassRequest` (session_id, file_path,
 * triggered_rule_ids, reason); the engine records it and returns the
 * persisted record's `{ id }`.
 */
export const BypassRequestSchema = z
    .object({
    session_id: z.string().min(1),
    file_path: z.string().min(1),
    triggered_rule_ids: z.array(z.string()),
    reason: z.string(),
    // The repo's bound project id; see GateRequestSchema. Attributes the
    // override to a project on the history dashboard.
    project_id: z.string().min(1).optional(),
})
    .strict();
export const BypassResponseSchema = z.object({ id: z.string() }).strict();
/**
 * Resolved autonomy policy (D-063). The plugin reads this at gate time to
 * decide whether to deliver the Rung-2 framing. Additive new type; `.strict()`
 * mirrors Pydantic `extra="forbid"`.
 */
export const PolicyResponseSchema = z.object({ autonomy_rung: z.string() }).strict();
export const AltitudeSchema = z.enum([
    'product-business',
    'architectural',
    'design',
    'implementation',
    'convention',
]);
export const RuleSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    altitude: AltitudeSchema,
    severity: SeveritySchema,
    language: z.string(),
    paths: z.array(z.string()),
});
export const RuleSummaryListSchema = z.array(RuleSummarySchema);
/**
 * A project the org owns, as listed for selection at `GET /mentor/projects`.
 * A project owns a *pool* of rules; binding a repo to a project scopes
 * evaluation to exactly those rules. Not `.strict()`: the platform may grow
 * this summary (it's a read-only listing surface) without breaking older
 * plugins, so unknown fields are tolerated here unlike the evaluation
 * request/response shapes above.
 */
export const ProjectSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    repo_full_name: z.string().nullable(),
    rule_count: z.number().int(),
});
export const ProjectSummaryListSchema = z.array(ProjectSummarySchema);
//# sourceMappingURL=schemas.js.map