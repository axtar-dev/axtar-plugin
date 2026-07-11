/**
 * Verdict → process exit + stderr formatter (D-022 revised, Phase 4 Step 7).
 *
 * We intentionally use the exit-code-2 + plain-text-stderr enforcement form
 * over the structured `permissionDecision: "deny"` JSON form. As of early
 * 2026, the JSON form has documented enforcement bugs (Anthropic GitHub
 * issues #4669, #18312, #37210) where deny is sometimes ignored for the
 * Edit tool, for tools in the settings allow-list, and for MCP tools — the
 * exact surfaces Axtar must block reliably. Reliability beats schema
 * cleanness given Axtar's "physically cannot bypass" positioning. Re-evaluate
 * once those bugs are confirmed fixed (parking-lot entry in PROGRESS.md).
 *
 * Per-hook semantics (D-022 revised again, Spike D verdict 2026-05-13):
 *   PreToolUse:
 *     - block  → exit 2 with the boxed-stderr layout below per violation.
 *     - warn   → exit 0 with the same layout. Caveat: PreToolUse exit 0
 *                routes stderr to the debug log only per Claude Code hooks
 *                docs — the agent does not see the rationale. No
 *                Pre-warn-severity rules ship today; revisit this code
 *                path if any are authored.
 *     - pass   → exit 0, no stderr.
 *   PostToolUse:
 *     - block | warn → exit 2 with the layout below. Per Claude Code
 *                hooks docs, PostToolUse exit 0 routes stderr to the
 *                debug log only (agent never sees it); exit 2 surfaces
 *                stderr to the agent's transcript. The tool already ran,
 *                so exit 2 can't "block" anything — the harness wraps
 *                the output with a cosmetic "blocking error" label that
 *                the agent reads through (Spike D verdict, 2026-05-13).
 *                The advisory is informational; the edit landed.
 *     - pass   → exit 0, no stderr.
 *
 * Layout (Phase 4 plan §7 / Step 7):
 *
 *   ─── Axtar blocked this edit ──────────────────────────────────────
 *
 *     AXT-JAVA-042 — Money values must use BigDecimal
 *
 *     WHY THIS RULE EXISTS:
 *       <foundation.rationale, indented>
 *
 *     WHAT WE FOUND:
 *       <message, indented; engine substitutes $X-style metavariables>
 *
 *     HOW TO FIX:
 *       <fix_suggestion, indented>
 *
 *     Spec: <foundation.spec>
 *     Authored by <foundation.authored_by> · enforced since <foundation.enforced_since>.
 *
 *   ──────────────────────────────────────────────────────────────────
 *   Resolve and retry.
 *
 * Design notes:
 *   - U+2500 box-drawing characters; no ASCII fallback. If a terminal
 *     can't render Unicode, the agent doesn't care.
 *   - No ANSI color codes — Claude Code's stderr surfacing may not
 *     preserve them and we won't bet the demo on it. Section headers
 *     in CAPS carry the visual hierarchy instead.
 *   - WHY THIS RULE EXISTS comes first deliberately: the war story is
 *     what convinces an LLM to self-correct rather than re-attempt with
 *     a tweak. RATIONALE: would read as sterile metadata; WHY THIS RULE
 *     EXISTS: reads as institutional voice. Visceral wins.
 *   - Conditional sections: omit WHY entirely if no rationale, HOW if
 *     no fix_suggestion, the footer line if neither authored_by nor
 *     enforced_since is set. Don't print empty headers.
 *   - Multi-violation: each violation rendered with the full internal
 *     layout, separated by a horizontal rule, single closing rule + footer
 *     at the end.
 *   - **Rule-name lookup is plugin-side, via the `RuleSummary` cache the
 *     hook already populated for path pre-filtering (D-020).** The wire
 *     `Violation` carries `rule_id` only; the formatter resolves the
 *     human-readable name from the cache passed in `RenderOptions`. If
 *     a name is missing (rule retired between fetch and verdict, cache
 *     was empty due to a fetch failure earlier in the hook), the rule
 *     line degrades to id-only — never crashes. D-029.
 */

import type { HookEmission, OutputAdapter, RenderContext } from '../../shared/output/adapter.js';
import type { EvaluateResponse, Verdict, Violation } from '../../shared/wire/schemas.js';

// `RenderOptions` is the in-file historical name; the shape is identical to
// `RenderContext` (the shared OutputAdapter input). Aliased here so the
// existing `renderVerdict` function signature stays byte-for-byte unchanged
// while the wider codebase consumes the shared name via the adapter object.
export type RenderOptions = RenderContext;

// `RenderedVerdict` historically constrained `exitCode` to `0 | 2` (Claude
// Code's only meaningful exit codes per D-022/D-036). The shared
// `HookEmission` widens `exitCode` to `number` and adds an optional
// `stdout` (codex uses stdout for its JSON envelope). The Claude Code
// adapter's emissions are still `{ exitCode: 0 | 2, stderr: string }` in
// practice; the alias loses the narrow `0 | 2` literal type because the
// runner consumes everything as `HookEmission`.
export type RenderedVerdict = HookEmission;

export function renderVerdict(response: EvaluateResponse, options: RenderOptions): RenderedVerdict {
  const { verdict, violations } = response;

  if (verdict === 'pass') {
    return { exitCode: 0, stderr: '' };
  }

  // pass returned above; verdict is block or warn here.
  //   PreToolUse  block → exit 2 (blocks tool call + surfaces stderr).
  //   PreToolUse  warn  → exit 0 (allowed through; stderr currently
  //                              swallowed by harness — no Pre-warn rules
  //                              ship today).
  //   PostToolUse block | warn → exit 2. Surfaces stderr to the agent's
  //                              transcript per Claude Code hooks docs.
  //                              Tool already ran; "blocking error"
  //                              harness label is cosmetic (Spike D).
  const exitCode: 0 | 2 =
    (options.hook === 'PreToolUse' && verdict === 'block') || options.hook === 'PostToolUse'
      ? 2
      : 0;

  return {
    exitCode,
    stderr: formatStderr(verdict, violations, options.hook, options.ruleNames),
  };
}

const BOX_WIDTH = 66;
const RULE_LINE = '─'.repeat(BOX_WIDTH);
// Single-space indent inside the box; double-space for body content under
// section headers. Visual hierarchy without color.
const BODY_INDENT = '  ';
const SECTION_INDENT = '    ';

function formatStderr(
  verdict: Verdict,
  violations: readonly Violation[],
  hook: 'PreToolUse' | 'PostToolUse',
  ruleNames: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];

  lines.push(headerLine(verdict, hook));

  violations.forEach((v, idx) => {
    if (idx > 0) {
      // Inter-violation separator: same horizontal rule as the closing line,
      // with a blank line on each side for breathing room.
      lines.push('');
      lines.push(RULE_LINE);
    }
    lines.push('');
    appendViolation(lines, v, ruleNames);
  });

  lines.push('');
  lines.push(RULE_LINE);
  lines.push(footerLine(verdict, hook));

  return lines.join('\n') + '\n';
}

function headerLine(verdict: Verdict, hook: 'PreToolUse' | 'PostToolUse'): string {
  const label = headerLabel(verdict, hook);
  return openBoxLine(label);
}

function headerLabel(verdict: Verdict, hook: 'PreToolUse' | 'PostToolUse'): string {
  if (hook === 'PreToolUse' && verdict === 'block') return 'Axtar blocked this edit';
  if (hook === 'PostToolUse' && verdict === 'block')
    return 'Axtar (post-edit): blocking rule violated';
  if (verdict === 'warn') return 'Axtar advisory';
  return 'Axtar';
}

/**
 * `─── <label> ` then pad with `─` out to BOX_WIDTH. Three leading dashes
 * frame the label without dominating it; the trailing fill anchors the
 * line visually so the agent can scan vertically and find rule boundaries.
 */
function openBoxLine(label: string): string {
  const head = `─── ${label} `;
  const fill = Math.max(3, BOX_WIDTH - head.length);
  return head + '─'.repeat(fill);
}

function appendViolation(
  lines: string[],
  v: Violation,
  ruleNames: ReadonlyMap<string, string>,
): void {
  // Rule line: `  AXT-JAVA-042 — Money values must use BigDecimal`.
  // Name comes from the in-memory `/rules` cache (D-020); fall back to
  // id-only if the lookup misses rather than rendering a malformed line.
  const name = ruleNames.get(v.rule_id);
  const ruleLabel = name ? `${v.rule_id} — ${name}` : v.rule_id;
  lines.push(`${BODY_INDENT}${ruleLabel}`);

  const rationale = v.foundation?.rationale?.trim();
  if (rationale) {
    lines.push('');
    lines.push(`${BODY_INDENT}WHY THIS RULE EXISTS:`);
    appendIndented(lines, rationale, SECTION_INDENT);
  }

  // WHAT WE FOUND is always present — message is required on Violation.
  lines.push('');
  lines.push(`${BODY_INDENT}WHAT WE FOUND:`);
  appendIndented(lines, v.message.trim(), SECTION_INDENT);

  const fix = v.fix_suggestion?.trim();
  if (fix) {
    lines.push('');
    lines.push(`${BODY_INDENT}HOW TO FIX:`);
    appendIndented(lines, fix, SECTION_INDENT);
  }

  const spec = v.foundation?.spec?.trim();
  const authored = v.foundation?.authored_by?.trim();
  const since = v.foundation?.enforced_since?.trim();

  if (spec || authored || since) {
    lines.push('');
    if (spec) lines.push(`${BODY_INDENT}Spec: ${spec}`);
    if (authored && since) {
      lines.push(`${BODY_INDENT}Authored by ${authored} · enforced since ${since}.`);
    } else if (authored) {
      lines.push(`${BODY_INDENT}Authored by ${authored}.`);
    } else if (since) {
      lines.push(`${BODY_INDENT}Enforced since ${since}.`);
    }
  }
}

function appendIndented(lines: string[], text: string, indent: string): void {
  for (const line of text.split('\n')) {
    lines.push(line.length > 0 ? `${indent}${line}` : '');
  }
}

function footerLine(verdict: Verdict, hook: 'PreToolUse' | 'PostToolUse'): string {
  if (hook === 'PreToolUse' && verdict === 'block') return 'Resolve and retry.';
  if (hook === 'PostToolUse' && verdict === 'block') {
    return 'Address the violation(s) above before continuing.';
  }
  return 'Note this and continue.';
}

export function renderEngineUnreachable(detail: string): string {
  return `axtar: engine unreachable (${detail}); allowing edit through.\n`;
}

// ───────────────────────────────────────────────────────────────────────────
// `claudeCodeOutputAdapter` — the named `OutputAdapter` per D-039. Wraps the
// existing `renderVerdict` and `renderEngineUnreachable` functions verbatim;
// no behavioural change. The runner consumes this object via injection
// (closes the shared/ → hosts/claude-code/ seam violation that 11.5.1b
// introduced).
// ───────────────────────────────────────────────────────────────────────────

export const claudeCodeOutputAdapter: OutputAdapter = {
  render(response, context) {
    let emission = renderVerdict(response, context);
    // v1 PostToolUse drift advisory — a RULE-SCOPED REMINDER (not a drift
    // verdict). Append the reminder to the Post stderr the verdict render
    // already produced, separated by a blank line. The exit code is left
    // UNCHANGED: the reminder never alters the verdict's exit semantics. The
    // Pre path is untouched (`driftAdvisory` is undefined on Pre).
    if (context.hook === 'PostToolUse' && context.driftAdvisory) {
      const prior = emission.stderr ?? '';
      const sep = prior.length > 0 ? '\n' : '';
      emission = { ...emission, stderr: `${prior}${sep}${context.driftAdvisory}\n` };
    }
    // Rung-2 heartbeat (D-063 secondary): the agent-visible Post channel is
    // additionalContext on stdout, and ONLY on exit 0 (exit 2 ignores stdout
    // JSON; exit-0 stderr is debug-only). Skip when the emission exits 2.
    if (context.hook === 'PostToolUse' && context.rungHeartbeat && emission.exitCode === 0) {
      const envelope = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: context.rungHeartbeat,
        },
      };
      emission = { ...emission, stdout: JSON.stringify(envelope) };
    }
    return emission;
  },
  renderEngineUnreachable(detail) {
    return { exitCode: 0, stderr: renderEngineUnreachable(detail) };
  },
  // Mentor gate block (G1): a real, server-issued denial. Same enforcement
  // form as a verdict block — exit 2 surfaces the message to the agent and
  // blocks the tool call. Boxed for visual parity with the verdict layout.
  renderMentorBlock(message) {
    return { exitCode: 2, stderr: boxMentor('Axtar Mentor — consult required', message) };
  },
  // Mentor gate bypass (G1): fail-open advisory. Exit 0 allows the edit; the
  // advisory rides on stderr (loud but non-blocking).
  renderMentorBypass(message) {
    return { exitCode: 0, stderr: boxMentor('Axtar Mentor — gate unreachable', message) };
  },
};

/**
 * Wrap a Mentor gate message in the same horizontal-rule frame the verdict
 * layout uses, so the block/bypass advisories read as Axtar output rather
 * than a stray log line. The message body is the pre-built host-neutral text
 * from `decideGate`; we only add the frame + trailing newline.
 */
function boxMentor(label: string, message: string): string {
  const lines: string[] = [];
  lines.push(openBoxLine(label));
  lines.push('');
  for (const line of message.split('\n')) {
    lines.push(line.length > 0 ? `${BODY_INDENT}${line}` : '');
  }
  lines.push('');
  lines.push(RULE_LINE);
  return lines.join('\n') + '\n';
}
