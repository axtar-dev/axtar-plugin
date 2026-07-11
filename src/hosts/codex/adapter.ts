/**
 * Codex output adapter — real implementation per D-039 (and the 11.5.2
 * reconciliation amendment naming the two-method interface).
 *
 * Renders the engine's host-neutral `EvaluateResponse` into codex's JSON
 * envelope, written to stdout. Both envelopes are CX-2-verified:
 *
 *   - PostToolUse advisory (CX-2 Variant A, 2026-05-21):
 *       {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *         "additionalContext":"<rendered advisory>"}}
 *     exit 0. `additionalContext` is the model-facing field the agent
 *     reads on the next turn — codex analog of [[D-036]]'s PostToolUse
 *     exit-2 stderr surface.
 *
 *   - PreToolUse block (CX-2 Variant C, 2026-05-25):
 *       {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *         "permissionDecision":"deny",
 *         "permissionDecisionReason":"<rendered advisory>"}}
 *     exit 0. The JSON envelope carries the decision; the hook process
 *     exits cleanly. Codex's PreToolUse does NOT accept
 *     `additionalContext`, so the discriminator on `RenderContext.hook`
 *     is load-bearing.
 *
 * Envelope shape is the canonical current spelling per codex 0.133.0;
 * the legacy `{"decision":"block","reason":"..."}` form is still
 * accepted by codex but not rendered here (D-039 envelope-corrected
 * commit).
 *
 * `renderEngineUnreachable`: codex fail-soft per [[D-014]] and the paper
 * §4 non-negotiable ("if the Axtar engine is unreachable, the plugin
 * warns but does not block"). Always renders the PostToolUse-shaped
 * `additionalContext` envelope (regardless of which hook is calling).
 * On PostToolUse, codex surfaces the advisory; on PreToolUse, no
 * `permissionDecision` means allow-through. The agent isn't blocked
 * either way. Operator rehearsal (11.5.6) verifies codex tolerates this
 * shape on PreToolUse.
 *
 * The advisory body (WHY THIS RULE EXISTS / WHAT WE FOUND / HOW TO FIX
 * / Spec) is host-neutral text — same content the Claude Code adapter
 * renders inside its boxed Unicode layout. Step 11.5.4 inlines a
 * codex-flavoured renderer here; if duplication grows, D-039 names the
 * shared advisory-body extraction as a natural future seam.
 */

import type { HookEmission, OutputAdapter, RenderContext } from '../../shared/output/adapter.js';
import type { EvaluateResponse, Verdict, Violation } from '../../shared/wire/schemas.js';

export const codexOutputAdapter: OutputAdapter = {
  render(response, context): HookEmission {
    const emission = renderCodex(response, context);
    // v1 PostToolUse drift advisory — a RULE-SCOPED REMINDER (not a drift
    // verdict). Merge the reminder into the Post `additionalContext` string so
    // it rides the existing envelope (no second JSON object). Exit code is left
    // UNCHANGED. Pre is untouched (`driftAdvisory` is undefined on Pre).
    if (context.hook === 'PostToolUse' && context.driftAdvisory) {
      return mergeDriftAdvisory(emission, context.driftAdvisory);
    }
    return emission;
  },
  renderEngineUnreachable(detail): HookEmission {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `axtar: engine unreachable (${detail}); allowing through.`,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(envelope) };
  },
  // Mentor gate block (G1): a real, server-issued denial — codex's deny
  // envelope (CX-2 Variant C), carrying the consult instruction as the
  // permission-decision reason. Exit 0; the envelope carries the decision.
  renderMentorBlock(message): HookEmission {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(envelope) };
  },
  // Mentor gate bypass (G1): fail-open advisory — codex's additionalContext
  // envelope. Exit 0 allows the edit; the advisory surfaces on the next turn.
  renderMentorBypass(message): HookEmission {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(envelope) };
  },
};

/**
 * Merge the v1 drift advisory into a Post emission's `additionalContext`. If
 * the Post render already produced a PostToolUse `additionalContext` envelope
 * (block | warn), append the advisory to it (blank-line separated) so the
 * reminder rides the same single JSON object. If the Post render produced no
 * envelope (a `pass` verdict, where renderCodex returns `{ exitCode: 0 }`),
 * synthesise the PostToolUse `additionalContext` envelope carrying just the
 * advisory. The exit code is preserved verbatim — the reminder never changes
 * verdict exit semantics. Always exactly one JSON object on stdout.
 */
function mergeDriftAdvisory(emission: HookEmission, advisory: string): HookEmission {
  let priorContext = '';
  if (emission.stdout) {
    try {
      const parsed = JSON.parse(emission.stdout) as {
        hookSpecificOutput?: { additionalContext?: unknown };
      };
      const existing = parsed.hookSpecificOutput?.additionalContext;
      if (typeof existing === 'string') priorContext = existing;
    } catch {
      // Non-JSON stdout is not expected on the Post path; fall through to a
      // fresh envelope carrying the advisory alone.
    }
  }
  const merged = priorContext.length > 0 ? `${priorContext}\n\n${advisory}` : advisory;
  const envelope = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: merged,
    },
  };
  return { ...emission, stdout: JSON.stringify(envelope) };
}

function renderCodex(response: EvaluateResponse, context: RenderContext): HookEmission {
  const { verdict, violations } = response;

  if (verdict === 'pass') {
    return { exitCode: 0 };
  }

  const body = formatAdvisory(verdict, violations, context.hook, context.ruleNames);

  if (context.hook === 'PreToolUse' && verdict === 'block') {
    const envelope = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: body,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(envelope) };
  }

  // PostToolUse (block | warn) OR PreToolUse warn — surface as
  // additionalContext on PostToolUse-shaped envelope. PreToolUse warn
  // emits the advisory under PostToolUse field (codex's PreToolUse
  // doesn't accept additionalContext); on PreToolUse the agent
  // continues. Acceptable fail-soft for the rare warn-on-Pre case;
  // no warn-on-Pre rules ship today.
  const hookEventName = context.hook === 'PreToolUse' ? 'PreToolUse' : 'PostToolUse';
  const envelope = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: body,
    },
  };
  return { exitCode: 0, stdout: JSON.stringify(envelope) };
}

// ───────────────────────────────────────────────────────────────────────────
// Advisory body renderer — host-neutral content, codex-flavoured plain
// text (no box-drawing characters; codex surfaces this as a single
// string in JSON, so the boxed layout from the Claude Code adapter
// would render with literal `─` characters in the agent's view).
// ───────────────────────────────────────────────────────────────────────────

const SECTION_INDENT = '  ';

function formatAdvisory(
  verdict: Verdict,
  violations: readonly Violation[],
  hook: 'PreToolUse' | 'PostToolUse',
  ruleNames: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  lines.push(headerLabel(verdict, hook));

  violations.forEach((v, idx) => {
    if (idx > 0) {
      lines.push('');
      lines.push('---');
    }
    lines.push('');
    appendViolation(lines, v, ruleNames);
  });

  lines.push('');
  lines.push(footerLine(verdict, hook));
  return lines.join('\n');
}

function headerLabel(verdict: Verdict, hook: 'PreToolUse' | 'PostToolUse'): string {
  if (hook === 'PreToolUse' && verdict === 'block') return 'Axtar blocked this edit:';
  if (hook === 'PostToolUse' && verdict === 'block') {
    return 'Axtar (post-edit): blocking rule violated.';
  }
  if (verdict === 'warn') return 'Axtar advisory:';
  return 'Axtar:';
}

function appendViolation(
  lines: string[],
  v: Violation,
  ruleNames: ReadonlyMap<string, string>,
): void {
  const name = ruleNames.get(v.rule_id);
  const ruleLabel = name ? `${v.rule_id} — ${name}` : v.rule_id;
  lines.push(ruleLabel);

  const rationale = v.foundation?.rationale?.trim();
  if (rationale) {
    lines.push('');
    lines.push('WHY THIS RULE EXISTS:');
    appendIndented(lines, rationale, SECTION_INDENT);
  }

  lines.push('');
  lines.push('WHAT WE FOUND:');
  appendIndented(lines, v.message.trim(), SECTION_INDENT);

  const fix = v.fix_suggestion?.trim();
  if (fix) {
    lines.push('');
    lines.push('HOW TO FIX:');
    appendIndented(lines, fix, SECTION_INDENT);
  }

  const spec = v.foundation?.spec?.trim();
  const authored = v.foundation?.authored_by?.trim();
  const since = v.foundation?.enforced_since?.trim();

  if (spec || authored || since) {
    lines.push('');
    if (spec) lines.push(`Spec: ${spec}`);
    if (authored && since) {
      lines.push(`Authored by ${authored} · enforced since ${since}.`);
    } else if (authored) {
      lines.push(`Authored by ${authored}.`);
    } else if (since) {
      lines.push(`Enforced since ${since}.`);
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
