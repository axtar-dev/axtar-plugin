/**
 * The plugin wire contract — `POST /mentor/checks/{diff,spec,scan}` (spec §9)
 * and the read-only `GET /mentor/projects` behind `axtar_projects`.
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
 * And nothing here throws. `parseDiffCheckResponse` / `parseScanCheckResponse` /
 * `parseSpecCheckResponse`
 * return a discriminated result carrying the raw body, so a drifted response is
 * rendered as *degraded but shown* (§12's fail-open direction applied to the
 * parser): the developer sees what came back plus a warning, never a crash and
 * never a fabricated verdict.
 */

import { z } from 'zod';

/** Routes, relative to the `/mentor` base URL in `AXTAR_ENGINE_URL`. */
export const DIFF_CHECK_PATH = '/checks/diff';
export const SCAN_CHECK_PATH = '/checks/scan';
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
export type PacketFile = z.infer<typeof PacketFileSchema>;

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
export type DiffCheckRequest = z.infer<typeof DiffCheckRequestSchema>;

/**
 * What `axtar_check_scan` ships — existing files, exactly as they are.
 *
 * No `diff` and no `base_ref`: this call audits what is in the tree, so there is
 * nothing to compare against. `files` is `min(1)` because the platform declares
 * `min_length=1` — a scan of nothing answered `clean` would be a lie, and the
 * producer refuses long before this schema has to. `paths_requested` is the
 * globs the caller asked for, verbatim; the platform records them and expands
 * nothing itself.
 */
export const ScanCheckRequestSchema = z
  .object({
    project: z.string().min(1),
    files: z.array(PacketFileSchema).min(1),
    paths_requested: z.array(z.string()),
    ref: z.string().optional(),
  })
  .strict();
export type ScanCheckRequest = z.infer<typeof ScanCheckRequestSchema>;

/** What `axtar_check_spec` ships — a plan, before any code exists. */
export const SpecCheckRequestSchema = z
  .object({
    project: z.string().min(1),
    spec: z.string().min(1),
    ref: z.string().optional(),
  })
  .strict();
export type SpecCheckRequest = z.infer<typeof SpecCheckRequestSchema>;

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
export type DroppedRule = z.infer<typeof DroppedRuleSchema>;

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
export type Finding = z.infer<typeof FindingSchema>;

/** A constraint the spec should carry but does not — "the point" of §9. */
export const MustStateSchema = z.object({
  rule_id: z.string(),
  rule_version: z.number().int(),
  statement: z.string().nullable(),
  why: z.string().nullable(),
  line_for_the_spec: z.string().nullable(),
  source: RuleSourceSchema,
});
export type MustState = z.infer<typeof MustStateSchema>;

/** A passage of the spec that a rule forbids. */
export const ConflictSchema = z.object({
  rule_id: z.string(),
  rule_version: z.number().int(),
  where_in_spec: z.string().nullable(),
  concern: z.string().nullable(),
  suggested_revision: z.string().nullable(),
  source: RuleSourceSchema,
});
export type Conflict = z.infer<typeof ConflictSchema>;

/** An implicated `should` rule the spec is silent about. */
export const UnaddressedSchema = z.object({
  rule_id: z.string(),
  rule_version: z.number().int(),
  statement: z.string().nullable(),
  why: z.string().nullable(),
});
export type Unaddressed = z.infer<typeof UnaddressedSchema>;

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
export type DiffCheckResponse = z.infer<typeof DiffCheckResponseSchema>;

/**
 * The audit of files as they stand (§9), and the receipt behind it (§10).
 *
 * The diff response **minus `unmet_spec`**, mirrored that way rather than
 * reusing `DiffCheckResponseSchema` with an empty array: a scan has no spec to
 * be unmet, and a contract carrying a field it can never fill teaches its
 * consumers the wrong shape. `breaches` here means "these rules are broken in
 * the code you asked about", not "this change broke them", and it gates nothing.
 */
export const ScanCheckResponseSchema = z.object({
  check_id: z.string(),
  url: z.string(),
  verdict: z.string(),
  breaches: z.array(FindingSchema),
  advisories: z.array(FindingSchema),
  considered: z.number().int(),
  checked: z.number().int(),
  dropped: z.array(DroppedRuleSchema),
  receipt: z.string(),
});
export type ScanCheckResponse = z.infer<typeof ScanCheckResponseSchema>;

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
export type SpecCheckResponse = z.infer<typeof SpecCheckResponseSchema>;

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
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectListSchema = z.array(ProjectSummarySchema);
export type ProjectList = z.infer<typeof ProjectListSchema>;

// --- tolerant parsing --------------------------------------------------------

/** A parsed response, or the raw body plus what did not line up. */
export type WireParse<T> = { ok: true; value: T } | { ok: false; issues: string[]; raw: unknown };

function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

function tolerant<T>(schema: z.ZodType<T>, raw: unknown): WireParse<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: issueLines(parsed.error), raw };
}

export function parseDiffCheckResponse(raw: unknown): WireParse<DiffCheckResponse> {
  return tolerant(DiffCheckResponseSchema, raw);
}

export function parseScanCheckResponse(raw: unknown): WireParse<ScanCheckResponse> {
  return tolerant(ScanCheckResponseSchema, raw);
}

export function parseSpecCheckResponse(raw: unknown): WireParse<SpecCheckResponse> {
  return tolerant(SpecCheckResponseSchema, raw);
}

export function parseProjectListResponse(raw: unknown): WireParse<ProjectList> {
  return tolerant(ProjectListSchema, raw);
}

/**
 * The receipt block (§10) rescued from a body this plugin could not fully
 * parse. Drift must not cost the developer the one thing every check owes
 * them — the addressable record — so if those three strings are present and
 * are strings, the degraded render still leads with them.
 */
export interface SalvagedReceipt {
  check_id: string;
  url: string;
  receipt: string;
}

export function salvageReceipt(raw: unknown): SalvagedReceipt | null {
  const shape = z
    .object({ check_id: z.string(), url: z.string(), receipt: z.string() })
    .safeParse(raw);
  return shape.success ? shape.data : null;
}
