/**
 * Rung-2 (autonomous resolution) wording + the gating constant (D-063/D-064/D-065).
 *
 * Single source for the standing authorization the gate block carries under
 * Rung 2, the draft-PR escalation action, and the Post-hook heartbeat. The rung
 * value is the wire string from `GET /mentor/policy` (PolicyResponse.autonomy_rung).
 *
 * The block framing is the LOAD-BEARING text of this milestone: it has to make a
 * fresh agent self-drive the gate→consult→approve loop without a hand-typed
 * instruction (the Trial-1 finding). It reaches the agent as TOOL OUTPUT, and
 * aligned models screen tool output for embedded instructions — an order away
 * from the human ("do NOT stop to ask") or an unconditional outward action
 * ("open a pull request") is the exact shape of a prompt injection, so the more
 * injection-resistant the model, the more reliably it refused the old framing.
 * The text therefore offers authorization an aligned agent can accept, rather
 * than orders it must obey:
 *   (a) provenance over prohibition — the owner deliberately configured this
 *       policy, so proceeding HONORS a standing human decision instead of
 *       bypassing one; "no mid-resolution check-in is needed (the owner reviews
 *       the finished result)" is a removed obligation, never "do not ask";
 *   (b) the loop, unweakened — consult → implement → retry until approved; the
 *       agent carries the resolution to completion (the Rung-2 core). The
 *       block's instructed workflow ends there;
 *   (c) NO PR pre-instruction — the block fires before any fix exists, so
 *       "open a pull request" in it is premature, mislocated (post-approval
 *       workflow, not block content), and the specific embedded instruction
 *       aligned agents flag. The judgment-calls disclosure (D-064,
 *       session_summary) attaches to the resolution summary — the agent's
 *       closing message — which populates a PR body only if the human's
 *       workflow opens one downstream;
 *   (d) the DRAFT-PR escalation (D-065) is distinct and stays: handing a
 *       genuine impasse to the owner through their chosen channel is the agent
 *       reaching the human, not a routine publish instruction.
 * It rides every block, so it must re-establish all of this with no reliance on
 * prior context.
 */

/** The wire value that turns Rung-2 autonomous resolution on. */
export const RUNG2_GATE_CERTIFIED = 'rung2_gate_certified';

/** True iff the resolved rung enables Rung-2 autonomy (undefined ⇒ Rung 1). */
export function isRung2(rung: string | undefined): boolean {
  return rung === RUNG2_GATE_CERTIFIED;
}

/** Standing Rung-2 authorization, appended to a consult/retry block (D-063 primary, D-064). */
export function rung2BlockFraming(): string {
  return [
    '— Axtar Rung 2: autonomous resolution (configured project policy) —',
    "This project's owner has deliberately configured Rung 2 for this repository: consultation blocks are resolved autonomously and reviewed as completed work. The owner has already decided to review the finished result rather than approve each step — resolving this yourself honors that standing choice rather than bypassing anyone, and no mid-resolution check-in is needed.",
    'Consult the Mentor as instructed above, implement the compliant approach it describes, and retry. If it still blocks, consult again and keep going until the Mentor approves — carry the resolution through to completion.',
    'In your resolution summary — the closing message where you report the finished work — surface the judgment calls: every choice the rules permitted but did not dictate (the "session_summary" tool returns that list).',
  ].join('\n');
}

/** Rung-2 escalation action — the impasse reaches the owner as a DRAFT PR (D-065). */
export function rung2EscalationFraming(): string {
  return [
    'Stop here — this is terminal, not another attempt. Do not retry this edit.',
    "Under this project's Rung-2 policy an impasse reaches the owner as a DRAFT pull request — the channel they chose for exactly this case, rather than a mid-session question. Open the draft capturing the impasse — what you tried, the rule(s) still triggered, and the Mentor's last rationale above — so the reviewer picks it up with full context. That handoff is how the human comes back in: once the draft is up, the resolution is theirs and the session can conclude.",
  ].join('\n');
}

/** Terse Rung-2 heartbeat for the Post-hook additionalContext channel (D-063 secondary). */
export function rung2Heartbeat(): string {
  return (
    'Axtar Rung 2 active (configured project policy): keep driving this to a ' +
    'Mentor-approved fix — the owner reviews the finished work rather than each step.'
  );
}
