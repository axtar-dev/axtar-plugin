/**
 * What the agent reads back — the text every tool call returns.
 *
 * **The receipt block leads, verbatim** (§10):
 *
 * ```
 * check_id: chk_7f2a91
 * url:      https://app.axtar.dev/checks/chk_7f2a91
 * summary:  212 considered · 209 checked · 3 dropped · 2 breaches · 1 advisory
 * ```
 *
 * That block is the product's evidence claim in three lines, and the summary
 * line is preformatted **by the platform** — it is rendered here exactly as it
 * arrived, never recomputed, so the transcript, the portal and the CI comment
 * are the same claim rather than three renderings of it.
 *
 * Everything else in this module is in service of that: findings cite
 * `id@version` because the record does (rules are versioned, history is not
 * rewritten), dropped rules are named because "what was not judged" is worth as
 * much as what was (invariant #9), and every failure path — engine down, schema
 * drift, an unbound repo — renders as text that says *no verdict was reached*.
 * A check that could not run must never read like a clean one.
 */

import type {
  Conflict,
  DiffCheckResponse,
  DroppedRule,
  Finding,
  MustState,
  ProjectSummary,
  ScanCheckResponse,
  SpecCheckResponse,
  Unaddressed,
} from './wire/checks.js';
import { salvageReceipt } from './wire/checks.js';

/** The §10 block, byte for byte what the tool descriptions tell agents to surface. */
export function receiptBlock(check: { check_id: string; url: string; receipt: string }): string {
  return [
    `check_id: ${check.check_id}`,
    `url:      ${check.url}`,
    `summary:  ${check.receipt}`,
  ].join('\n');
}

const SURFACE_IT =
  'Surface the three receipt lines above in your summary and in any PR description you write — ' +
  'they are the evidence this change was checked against the whole corpus.';

/**
 * The same instruction for an audit, which has no change and usually no PR:
 * what the receipt proves is that *these files* were measured against the whole
 * corpus, so the claim it licenses is about the code, not about a diff.
 */
const SURFACE_IT_SCAN =
  'Surface the three receipt lines above in your summary — they are the evidence these files ' +
  'were checked against the whole corpus.';

// --- shared pieces -----------------------------------------------------------

function ruleRef(finding: { rule_id: string; rule_version: number }): string {
  return `${finding.rule_id}@${finding.rule_version}`;
}

function location(finding: Finding): string | null {
  if (finding.path === null) return null;
  return finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
}

/** `{kind, ref, excerpt}` today; read defensively because the platform types it loosely. */
function sourceLine(source: Record<string, unknown> | null): string | null {
  if (source === null) return null;
  const parts: string[] = [];
  const kind = source['kind'];
  const ref = source['ref'];
  if (typeof kind === 'string' && kind.length > 0) parts.push(kind);
  if (typeof ref === 'string' && ref.length > 0) parts.push(ref);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function field(label: string, value: string | null): string[] {
  if (value === null || value.trim().length === 0) return [];
  return [`   ${label.padEnd(10)}${value.trim()}`];
}

function findingBlock(index: number, finding: Finding): string {
  const head = [ruleRef(finding)];
  if (finding.severity !== null) head.push(finding.severity);
  const where = location(finding);
  if (where !== null) head.push(where);
  if (finding.defended) head.push('defended');
  if (finding.cache_sourced) head.push('from cache');

  return [
    `${index}. ${head.join(' · ')}`,
    ...field('evidence:', finding.evidence_quote),
    ...field('why:', finding.why),
    ...field('fix:', finding.fix),
    ...field('source:', sourceLine(finding.source)),
  ].join('\n');
}

function findingSection(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [];
  return [
    '',
    `${title} (${findings.length})`,
    ...findings.map((finding, i) => findingBlock(i + 1, finding)),
  ];
}

/** Invariant #9 made visible: a dropped rule is named, with why. */
function droppedSection(dropped: DroppedRule[]): string[] {
  if (dropped.length === 0) return [];
  const listed = dropped.map((entry) => `${entry.rule_id} (${entry.reason})`).join(', ');
  return [
    '',
    `NOT JUDGED (${dropped.length}) — these rules were in scope and were not checked:`,
    `   ${listed}`,
  ];
}

// --- diff --------------------------------------------------------------------

export function renderDiffResponse(response: DiffCheckResponse): string {
  const lines = [receiptBlock(response), '', `verdict:  ${response.verdict}`];

  if (response.breaches.length === 0 && response.advisories.length === 0) {
    lines.push('', 'No breaches and no advisories — every rule that was checked held.');
  }

  lines.push(
    ...findingSection('BREACHES', response.breaches),
    ...findingSection('ADVISORIES', response.advisories),
    ...findingSection('UNMET SPEC', response.unmet_spec),
    ...droppedSection(response.dropped),
    '',
    SURFACE_IT,
  );
  return lines.join('\n');
}

// --- scan --------------------------------------------------------------------

/**
 * The audit of existing files — the diff render's own sections, minus the one a
 * scan can never have.
 *
 * `unmet_spec` is absent because the response has no such field: there is no
 * spec to be unmet when nothing was proposed. The verdict carries a note that a
 * scan gates nothing, because `breaches` on an audit means "the code already
 * breaks these rules", which is a backlog, not a blocked change.
 */
export function renderScanResponse(response: ScanCheckResponse): string {
  const lines = [
    receiptBlock(response),
    '',
    `verdict:  ${response.verdict} (an audit of the files as they are — a scan gates nothing)`,
  ];

  if (response.breaches.length === 0 && response.advisories.length === 0) {
    lines.push(
      '',
      'No breaches and no advisories — every rule that was checked held in these files.',
    );
  }

  lines.push(
    ...findingSection('BREACHES', response.breaches),
    ...findingSection('ADVISORIES', response.advisories),
    ...droppedSection(response.dropped),
    '',
    SURFACE_IT_SCAN,
  );
  return lines.join('\n');
}

// --- spec --------------------------------------------------------------------

function mustStateLine(entry: MustState): string {
  const text = entry.line_for_the_spec ?? entry.statement ?? `see ${ruleRef(entry)}`;
  return `- ${text.trim()}`;
}

function mustStateDetail(index: number, entry: MustState): string {
  return [
    `${index}. ${ruleRef(entry)}`,
    ...field('states:', entry.statement),
    ...field('why:', entry.why),
    ...field('source:', sourceLine(entry.source)),
  ].join('\n');
}

function conflictBlock(index: number, entry: Conflict): string {
  return [
    `${index}. ${ruleRef(entry)}`,
    ...field('in spec:', entry.where_in_spec),
    ...field('concern:', entry.concern),
    ...field('revise:', entry.suggested_revision),
    ...field('source:', sourceLine(entry.source)),
  ].join('\n');
}

function unaddressedBlock(index: number, entry: Unaddressed): string {
  return [
    `${index}. ${ruleRef(entry)}`,
    ...field('states:', entry.statement),
    ...field('why:', entry.why),
  ].join('\n');
}

export function renderSpecResponse(response: SpecCheckResponse): string {
  const lines = [
    receiptBlock(response),
    '',
    `verdict:  ${response.verdict} (advisory — a spec check never gates)`,
  ];

  if (response.must_state.length > 0) {
    lines.push(
      '',
      `MUST STATE (${response.must_state.length}) — paste these lines into the spec:`,
      '',
      ...response.must_state.map(mustStateLine),
      '',
      'Where they come from:',
      ...response.must_state.map((entry, i) => mustStateDetail(i + 1, entry)),
    );
  }

  if (response.conflicts.length > 0) {
    lines.push(
      '',
      `CONFLICTS (${response.conflicts.length}) — the spec says something a rule forbids:`,
      ...response.conflicts.map((entry, i) => conflictBlock(i + 1, entry)),
    );
  }

  if (response.unaddressed.length > 0) {
    lines.push(
      '',
      `UNADDRESSED (${response.unaddressed.length}) — implicated rules the spec is silent about:`,
      ...response.unaddressed.map((entry, i) => unaddressedBlock(i + 1, entry)),
    );
  }

  if (response.open_questions.length > 0) {
    lines.push(
      '',
      `OPEN QUESTIONS (${response.open_questions.length}):`,
      ...response.open_questions.map((question) => `- ${question}`),
    );
  }

  if (
    response.must_state.length === 0 &&
    response.conflicts.length === 0 &&
    response.unaddressed.length === 0
  ) {
    lines.push('', 'Nothing to add — the spec already carries the constraints that were checked.');
  }

  lines.push(...droppedSection(response.dropped), '', SURFACE_IT);
  return lines.join('\n');
}

// --- projects: which one governs this repo, and how to change it -------------

/** Everything `renderProjects` needs, as plain data — no config plumbing here. */
export interface ProjectsView {
  /** Every project the API key can see, in the order the platform returned. */
  projects: ProjectSummary[];
  /** The id `.axtar/config.yml` binds this repo to, or null when unbound. */
  boundProjectId: string | null;
  /** Absolute path of the config that id came from, when there is one. */
  configPath: string | null;
  /**
   * Why this repo has no binding, in the caller's words. Set only when
   * `boundProjectId` is null — and when it is set it is rendered **first**,
   * because an unbound repo's question is never "which projects exist" but
   * "how do I bind this one".
   */
  unboundReason: string | null;
}

const PLACEHOLDER_ID = '<project id from the portal>';

function projectBlock(index: number, project: ProjectSummary, bound: boolean): string {
  return [
    `${index}. ${project.name}${bound ? '   ← this repo is bound to this project' : ''}`,
    `   id:     ${project.id}`,
    `   rules:  ${project.rule_count} in the pool`,
    `   repo:   ${project.repo_full_name ?? '(none linked)'}`,
  ].join('\n');
}

/**
 * The `.axtar/config.yml` snippet, then the three shapes §6 allows.
 *
 * This footer is the whole point of the tool: the plugin cannot bind a repo —
 * **the committed file is the only binding mechanism** and nothing here ever
 * writes it — so what an agent can be given is the exact text to write, the
 * reminder that it has to be committed (and pushed before ingest can read it),
 * and the shapes it may take.
 */
function bindingFooter(projectId: string): string {
  return [
    'HOW TO BIND OR SWITCH — .axtar/config.yml at the repo root is the only binding',
    'mechanism. There is no server-side selection: to change project, change this file.',
    '',
    'version: 1',
    `project: ${projectId}`,
    '',
    'Commit it — the binding travels with the repo, not with a machine — and push it',
    'before running ingest: the platform reads the committed file from the remote, so',
    'an unpushed change is a change ingest cannot see.',
    '',
    'The three shapes the file may take (spec §6):',
    '- binding-only — `version:` + `project:` and nothing else. Checks run against the',
    "  project's rules; ingest reads nothing from this repo.",
    '- docs-only — plus a `knowledge.docs:` list of `- path: <glob>` entries; a doc',
    '  marked `kind: reference` is context only and never becomes a rule.',
    '- docs+code — plus `knowledge.code:` with `enabled: true` and `include:` /',
    '  `exclude:` globs, so conventions nobody wrote down are induced from the source.',
    '',
    'Run /axtar:projects to have the file written for you, /axtar:status to verify it.',
  ].join('\n');
}

export function renderProjects(view: ProjectsView): string {
  const lines: string[] = [];

  if (view.unboundReason !== null) {
    lines.push(
      'This repo is bound to no Axtar project.',
      `- ${view.unboundReason}`,
      '- Until it is bound, axtar_check_spec and axtar_check_diff refuse here — pick a ' +
        'project below and write the config at the end of this message.',
      '',
    );
  }

  const bound = view.projects.find((project) => project.id === view.boundProjectId);
  if (view.boundProjectId !== null) {
    const named = bound === undefined ? '' : ` ("${bound.name}")`;
    lines.push(
      `This repo is bound to project ${view.boundProjectId}${named}` +
        `${view.configPath === null ? '' : `, per ${view.configPath}`}.`,
    );
    if (bound === undefined) {
      lines.push(
        'That id is NOT in the list below — it belongs to another organization, or the ' +
          'project was deleted. Checks against it will fail until the config names a ' +
          'project this API key can see.',
      );
    }
    lines.push('');
  }

  if (view.projects.length === 0) {
    lines.push(
      'This API key can see no projects. Create one in the Axtar portal first — the portal ' +
        'issues the project id the config has to carry.',
    );
  } else {
    lines.push(
      `PROJECTS (${view.projects.length}) — every project this API key can see:`,
      ...view.projects.map((project, i) =>
        projectBlock(i + 1, project, project.id === view.boundProjectId),
      ),
    );
  }

  lines.push('', bindingFooter(bound?.id ?? view.projects[0]?.id ?? PLACEHOLDER_ID));
  return lines.join('\n');
}

/**
 * The platform could not be asked which projects exist.
 *
 * Fails open like every other agent-facing path (§12) — and still ends with the
 * binding footer, because *how* to bind a repo is local knowledge that does not
 * depend on the platform being up. Only the list of names was lost.
 */
export function renderProjectsFailure(
  reason: string,
  boundProjectId: string | null,
  hint?: string,
): string {
  return [
    'Axtar could not list your projects.',
    `reason: ${reason}`,
    ...(hint === undefined ? [] : [`hint:   ${hint}`]),
    '',
    'This is not a verdict about anything: no check ran, and no rule was cleared.',
    boundProjectId === null
      ? 'This repo names no project either, so nothing governs it yet.'
      : `This repo still names project ${boundProjectId} — the committed config is unaffected ` +
        'by the platform being unreachable.',
    '',
    bindingFooter(boundProjectId ?? PLACEHOLDER_ID),
  ].join('\n');
}

// --- degraded: the platform answered, the contract moved ---------------------

const MAX_RAW = 4000;

function rawJson(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    text = String(raw);
  }
  return text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}\n… (truncated)` : text;
}

/** The wire surfaces a drifted body can arrive on, named as the agent reads them. */
export type WireSurface = 'diff' | 'scan' | 'spec' | 'projects';

const SURFACE_LABEL: Record<WireSurface, string> = {
  diff: 'diff check',
  scan: 'conformance scan',
  spec: 'spec check',
  projects: 'projects listing',
};

/**
 * A response this plugin's schemas could not parse.
 *
 * Shown, not swallowed: the platform judged something, and hiding its answer
 * behind a parse error would cost the developer a real check. The receipt is
 * salvaged when it is there, so the record stays addressable either way.
 */
export function renderSchemaDrift(
  kind: WireSurface,
  parsed: { issues: string[]; raw: unknown },
): string {
  const salvaged = salvageReceipt(parsed.raw);
  const lines: string[] = [];
  if (salvaged !== null) lines.push(receiptBlock(salvaged), '');
  lines.push(
    `Schema drift: the ${SURFACE_LABEL[kind]} returned a body this plugin does not fully understand.`,
    'The platform is ahead of (or behind) this plugin version — update it with `/plugin update axtar`.',
    '',
    'What did not line up:',
    ...parsed.issues.map((issue) => `- ${issue}`),
    '',
    'What came back, verbatim — read it, but treat the shape as unverified:',
    rawJson(parsed.raw),
  );
  return lines.join('\n');
}

// --- refusals and fail-open --------------------------------------------------

/**
 * The tools refuse rather than check against nothing (§15). A refusal is not a
 * verdict and says so — a "no config" message an agent reads as "clean" would
 * be the worst failure this product has.
 */
export function renderRefusal(title: string, instructions: string[]): string {
  return [
    `${title} — no check ran.`,
    ...instructions.map((line) => `- ${line}`),
    '',
    'This is not a verdict: no rule was checked, so nothing was cleared.',
  ].join('\n');
}

/**
 * **The agent surface fails open** (§12): a platform hiccup returns this text,
 * never an exception. It says what broke, that no verdict exists, and that the
 * developer may proceed — CI is the surface that fails closed.
 */
export function renderFailOpen(what: string, reason: string, hint?: string): string {
  return [
    `Axtar could not run the ${what} check.`,
    `reason: ${reason}`,
    ...(hint === undefined ? [] : [`hint:   ${hint}`]),
    '',
    'No verdict exists: nothing was checked, and no breach was found or ruled out.',
    'Work may proceed — re-run the check once the platform is reachable, and say in your ' +
      'summary that the check did not run.',
  ].join('\n');
}
