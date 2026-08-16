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
import { salvageReceipt } from './wire/checks.js';
/** The §10 block, byte for byte what the tool descriptions tell agents to surface. */
export function receiptBlock(check) {
    return [
        `check_id: ${check.check_id}`,
        `url:      ${check.url}`,
        `summary:  ${check.receipt}`,
    ].join('\n');
}
const SURFACE_IT = 'Surface the three receipt lines above in your summary and in any PR description you write — ' +
    'they are the evidence this change was checked against the whole corpus.';
// --- shared pieces -----------------------------------------------------------
function ruleRef(finding) {
    return `${finding.rule_id}@${finding.rule_version}`;
}
function location(finding) {
    if (finding.path === null)
        return null;
    return finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
}
/** `{kind, ref, excerpt}` today; read defensively because the platform types it loosely. */
function sourceLine(source) {
    if (source === null)
        return null;
    const parts = [];
    const kind = source['kind'];
    const ref = source['ref'];
    if (typeof kind === 'string' && kind.length > 0)
        parts.push(kind);
    if (typeof ref === 'string' && ref.length > 0)
        parts.push(ref);
    return parts.length > 0 ? parts.join(' · ') : null;
}
function field(label, value) {
    if (value === null || value.trim().length === 0)
        return [];
    return [`   ${label.padEnd(10)}${value.trim()}`];
}
function findingBlock(index, finding) {
    const head = [ruleRef(finding)];
    if (finding.severity !== null)
        head.push(finding.severity);
    const where = location(finding);
    if (where !== null)
        head.push(where);
    if (finding.defended)
        head.push('defended');
    if (finding.cache_sourced)
        head.push('from cache');
    return [
        `${index}. ${head.join(' · ')}`,
        ...field('evidence:', finding.evidence_quote),
        ...field('why:', finding.why),
        ...field('fix:', finding.fix),
        ...field('source:', sourceLine(finding.source)),
    ].join('\n');
}
function findingSection(title, findings) {
    if (findings.length === 0)
        return [];
    return [
        '',
        `${title} (${findings.length})`,
        ...findings.map((finding, i) => findingBlock(i + 1, finding)),
    ];
}
/** Invariant #9 made visible: a dropped rule is named, with why. */
function droppedSection(dropped) {
    if (dropped.length === 0)
        return [];
    const listed = dropped.map((entry) => `${entry.rule_id} (${entry.reason})`).join(', ');
    return [
        '',
        `NOT JUDGED (${dropped.length}) — these rules were in scope and were not checked:`,
        `   ${listed}`,
    ];
}
// --- diff --------------------------------------------------------------------
export function renderDiffResponse(response) {
    const lines = [receiptBlock(response), '', `verdict:  ${response.verdict}`];
    if (response.breaches.length === 0 && response.advisories.length === 0) {
        lines.push('', 'No breaches and no advisories — every rule that was checked held.');
    }
    lines.push(...findingSection('BREACHES', response.breaches), ...findingSection('ADVISORIES', response.advisories), ...findingSection('UNMET SPEC', response.unmet_spec), ...droppedSection(response.dropped), '', SURFACE_IT);
    return lines.join('\n');
}
// --- spec --------------------------------------------------------------------
function mustStateLine(entry) {
    const text = entry.line_for_the_spec ?? entry.statement ?? `see ${ruleRef(entry)}`;
    return `- ${text.trim()}`;
}
function mustStateDetail(index, entry) {
    return [
        `${index}. ${ruleRef(entry)}`,
        ...field('states:', entry.statement),
        ...field('why:', entry.why),
        ...field('source:', sourceLine(entry.source)),
    ].join('\n');
}
function conflictBlock(index, entry) {
    return [
        `${index}. ${ruleRef(entry)}`,
        ...field('in spec:', entry.where_in_spec),
        ...field('concern:', entry.concern),
        ...field('revise:', entry.suggested_revision),
        ...field('source:', sourceLine(entry.source)),
    ].join('\n');
}
function unaddressedBlock(index, entry) {
    return [
        `${index}. ${ruleRef(entry)}`,
        ...field('states:', entry.statement),
        ...field('why:', entry.why),
    ].join('\n');
}
export function renderSpecResponse(response) {
    const lines = [
        receiptBlock(response),
        '',
        `verdict:  ${response.verdict} (advisory — a spec check never gates)`,
    ];
    if (response.must_state.length > 0) {
        lines.push('', `MUST STATE (${response.must_state.length}) — paste these lines into the spec:`, '', ...response.must_state.map(mustStateLine), '', 'Where they come from:', ...response.must_state.map((entry, i) => mustStateDetail(i + 1, entry)));
    }
    if (response.conflicts.length > 0) {
        lines.push('', `CONFLICTS (${response.conflicts.length}) — the spec says something a rule forbids:`, ...response.conflicts.map((entry, i) => conflictBlock(i + 1, entry)));
    }
    if (response.unaddressed.length > 0) {
        lines.push('', `UNADDRESSED (${response.unaddressed.length}) — implicated rules the spec is silent about:`, ...response.unaddressed.map((entry, i) => unaddressedBlock(i + 1, entry)));
    }
    if (response.open_questions.length > 0) {
        lines.push('', `OPEN QUESTIONS (${response.open_questions.length}):`, ...response.open_questions.map((question) => `- ${question}`));
    }
    if (response.must_state.length === 0 &&
        response.conflicts.length === 0 &&
        response.unaddressed.length === 0) {
        lines.push('', 'Nothing to add — the spec already carries the constraints that were checked.');
    }
    lines.push(...droppedSection(response.dropped), '', SURFACE_IT);
    return lines.join('\n');
}
// --- degraded: the platform answered, the contract moved ---------------------
const MAX_RAW = 4000;
function rawJson(raw) {
    let text;
    try {
        text = JSON.stringify(raw, null, 2) ?? String(raw);
    }
    catch {
        text = String(raw);
    }
    return text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}\n… (truncated)` : text;
}
/**
 * A response this plugin's schemas could not parse.
 *
 * Shown, not swallowed: the platform judged something, and hiding its answer
 * behind a parse error would cost the developer a real check. The receipt is
 * salvaged when it is there, so the record stays addressable either way.
 */
export function renderSchemaDrift(kind, parsed) {
    const salvaged = salvageReceipt(parsed.raw);
    const lines = [];
    if (salvaged !== null)
        lines.push(receiptBlock(salvaged), '');
    lines.push(`Schema drift: the ${kind} check returned a body this plugin does not fully understand.`, 'The platform is ahead of (or behind) this plugin version — update it with `/plugin update axtar`.', '', 'What did not line up:', ...parsed.issues.map((issue) => `- ${issue}`), '', 'What came back, verbatim — read it, but treat the shape as unverified:', rawJson(parsed.raw));
    return lines.join('\n');
}
// --- refusals and fail-open --------------------------------------------------
/**
 * The tools refuse rather than check against nothing (§15). A refusal is not a
 * verdict and says so — a "no config" message an agent reads as "clean" would
 * be the worst failure this product has.
 */
export function renderRefusal(title, instructions) {
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
export function renderFailOpen(what, reason, hint) {
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
//# sourceMappingURL=render.js.map