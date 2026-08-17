/**
 * The plugin wire contract — `POST /mentor/checks/{diff,spec}` (spec §9) and
 * the read-only `GET /mentor/projects` behind `axtar_projects`.
 *
 * These schemas are a **mirror of the platform's `api/app/schemas/plugin/
 * check.py`** (and `project.py`), field for field. Those files are the
 * authority; when they change, this one changes with them, and
 * `test/fixtures/wire/*.json` are the pinned examples that make a silent skew
 * fail in this repo's CI.
 *
 * Two deliberately different strictnesses, because the two directions have
 * opposite failure costs:
 *
 * - **Requests are `.strict()`.** The platform declares `extra="forbid"`, so a
 *   field it does not understand is a 422 anyway; catching it here names the
 *   offending key instead of shipping a packet that was never judged.
 * - **Responses ignore unknown keys.** A field the platform *added* must never
 *   blind a developer to a real judgment — the receipt they are owed is already
 *   in the body. A field that was *renamed or dropped* still fails, which is the
 *   skew worth shouting about.
 *
 * And nothing here throws. `parseDiffCheckResponse` / `parseSpecCheckResponse`
 * return a discriminated result carrying the raw body, so a drifted response is
 * rendered as *degraded but shown* (§12's fail-open direction applied to the
 * parser): the developer sees what came back plus a warning, never a crash and
 * never a fabricated verdict.
 */
import { z } from 'zod';
/** Routes, relative to the `/mentor` base URL in `AXTAR_ENGINE_URL`. */
export const DIFF_CHECK_PATH = '/checks/diff';
export const SPEC_CHECK_PATH = '/checks/spec';
export const PROJECTS_PATH = '/projects';
// --- requests (producer → platform) -----------------------------------------
/** One changed file at full content — the working tree's version of it. */
export const PacketFileSchema = z
    .object({
    path: z.string(),
    content: z.string(),
})
    .strict();
/**
 * What `axtar_check_diff` ships: whole files, not hunks, plus the diff and the
 * base it was taken against. `project` is a platform project id (a UUID) and is
 * sent as the config spells it — the platform is the side that decides whether
 * it exists.
 */
export const DiffCheckRequestSchema = z
    .object({
    project: z.string().min(1),
    diff: z.string(),
    base_ref: z.string().min(1),
    files: z.array(PacketFileSchema),
    spec: z.string().optional(),
    ref: z.string().optional(),
})
    .strict();
/** What `axtar_check_spec` ships — a plan, before any code exists. */
export const SpecCheckRequestSchema = z
    .object({
    project: z.string().min(1),
    spec: z.string().min(1),
    ref: z.string().optional(),
})
    .strict();
// --- responses (platform → producer) ----------------------------------------
/**
 * The rule's own source at judge time — `{kind, ref, excerpt}` today, kept as a
 * loose record because the platform types it `dict[str, object]` and the
 * renderer reads it defensively.
 */
export const RuleSourceSchema = z.record(z.unknown()).nullable();
/** A rule that was in scope and NOT judged, with why (invariant #9). */
export const DroppedRuleSchema = z.object({
    rule_id: z.string(),
    reason: z.string(),
});
/** One breach or advisory, cited (invariant #7). */
export const FindingSchema = z.object({
    rule_id: z.string(),
    rule_version: z.number().int(),
    severity: z.string().nullable(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    evidence_quote: z.string().nullable(),
    why: z.string().nullable(),
    fix: z.string().nullable(),
    source: RuleSourceSchema,
    defended: z.boolean(),
    cache_sourced: z.boolean(),
});
/** A constraint the spec should carry but does not — "the point" of §9. */
export const MustStateSchema = z.object({
    rule_id: z.string(),
    rule_version: z.number().int(),
    statement: z.string().nullable(),
    why: z.string().nullable(),
    line_for_the_spec: z.string().nullable(),
    source: RuleSourceSchema,
});
/** A passage of the spec that a rule forbids. */
export const ConflictSchema = z.object({
    rule_id: z.string(),
    rule_version: z.number().int(),
    where_in_spec: z.string().nullable(),
    concern: z.string().nullable(),
    suggested_revision: z.string().nullable(),
    source: RuleSourceSchema,
});
/** An implicated `should` rule the spec is silent about. */
export const UnaddressedSchema = z.object({
    rule_id: z.string(),
    rule_version: z.number().int(),
    statement: z.string().nullable(),
    why: z.string().nullable(),
});
/**
 * The judgment on one change, and the receipt behind it (§10).
 *
 * `verdict` stays a plain string rather than an enum: an outcome this plugin
 * has not heard of is information, not a parse failure, and degrading a whole
 * response over it would hide findings the platform did produce.
 */
export const DiffCheckResponseSchema = z.object({
    check_id: z.string(),
    url: z.string(),
    verdict: z.string(),
    breaches: z.array(FindingSchema),
    advisories: z.array(FindingSchema),
    unmet_spec: z.array(FindingSchema),
    considered: z.number().int(),
    checked: z.number().int(),
    dropped: z.array(DroppedRuleSchema),
    receipt: z.string(),
});
/** The review of one plan (§9). Advisory — a spec check never gates. */
export const SpecCheckResponseSchema = z.object({
    check_id: z.string(),
    url: z.string(),
    verdict: z.string(),
    must_state: z.array(MustStateSchema),
    conflicts: z.array(ConflictSchema),
    unaddressed: z.array(UnaddressedSchema),
    open_questions: z.array(z.string()),
    considered: z.number().int(),
    checked: z.number().int(),
    dropped: z.array(DroppedRuleSchema),
    receipt: z.string(),
});
// --- projects (platform → plugin) -------------------------------------------
/**
 * One row of `GET /mentor/projects` — a mirror of the platform's
 * `api/app/schemas/plugin/project.py::ProjectSummary`.
 *
 * Read-only, and deliberately so: listing the org's projects is *not* a
 * selection. The committed `.axtar/config.yml` remains the only binding
 * mechanism (§6), and the platform keeps no per-repo selection record — which
 * is why nothing in this contract has a write direction.
 *
 * `id` stays a plain string rather than a UUID: the config carries whatever the
 * portal issued, and rejecting a row over an id format would hide a project the
 * developer can plainly see in the portal. `repo_full_name` is `"owner/repo"`
 * when the platform could parse it at project creation, else null.
 */
export const ProjectSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    repo_full_name: z.string().nullable(),
    rule_count: z.number().int(),
});
export const ProjectListSchema = z.array(ProjectSummarySchema);
function issueLines(error) {
    return error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
    });
}
function tolerant(schema, raw) {
    const parsed = schema.safeParse(raw);
    if (parsed.success)
        return { ok: true, value: parsed.data };
    return { ok: false, issues: issueLines(parsed.error), raw };
}
export function parseDiffCheckResponse(raw) {
    return tolerant(DiffCheckResponseSchema, raw);
}
export function parseSpecCheckResponse(raw) {
    return tolerant(SpecCheckResponseSchema, raw);
}
export function parseProjectListResponse(raw) {
    return tolerant(ProjectListSchema, raw);
}
export function salvageReceipt(raw) {
    const shape = z
        .object({ check_id: z.string(), url: z.string(), receipt: z.string() })
        .safeParse(raw);
    return shape.success ? shape.data : null;
}
//# sourceMappingURL=checks.js.map