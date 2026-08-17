/**
 * The turn-end reminder — the plugin's **only** hook, and an advisory one.
 *
 * It fires on Claude Code's `Stop` event: when the agent has finished its whole
 * turn, never per edit and never before a tool call. It evaluates no code, calls
 * the platform not at all, and blocks nothing a developer is waiting on. Its
 * entire job is one sentence, said at most once per unchecked tree state: *this
 * turn changed code that was never checked — run `axtar_check_diff`, surface the
 * receipt, then finish.*
 *
 * **This is not the old gate.** The deleted `PreToolUse`/`PostToolUse` hooks
 * judged every edit against the engine and could deny one; nothing here can. The
 * agent stays in charge of when a check happens; the reminder only makes
 * forgetting visible.
 *
 * **Loop-proof by construction.** A `Stop` hook that blocks fires again when the
 * agent stops again, so every path out of `decide` is an allow unless the tree
 * is in a state that has never been checked *and* never been nudged. The stop is
 * allowed when
 *
 *  a. the repo has no `.axtar/config.yml` — Axtar does not govern it;
 *  b. the tree is clean — this turn changed nothing to check;
 *  c. the tree state matches `last_checked_hash` — it was already checked;
 *  d. the tree state matches `last_nudged_hash` — it was already nudged once,
 *     and a check that could not run (engine down, key missing) must not turn
 *     into a nag on every turn;
 *  e. `stop_hook_active` is set — a Stop hook already continued this turn;
 *  f. `AXTAR_NO_REMINDER` is set — the documented off switch.
 *
 * Anything unexpected — bad stdin, no git, an unwritable state dir — is also an
 * allow: silence is the failure mode this hook is allowed to have.
 *
 * **stdout here is the hook's decision channel** (not JSON-RPC — that is the MCP
 * server's stdout, CLAUDE.md invariant #1). Exactly one JSON object is ever
 * written to it, and only on a nudge; diagnostics go to stderr through
 * `shared/log.ts`.
 */
import { findRepoRoot } from '../shared/producer.js';
import { log } from '../shared/log.js';
import { loadRepoBinding } from '../shared/project/config.js';
import { defaultStateDir, readState, readWorkTreeState, writeState } from '../shared/tree-state.js';
/** The documented off switch — set to anything non-empty and this hook never speaks. */
export const OFF_SWITCH_ENV = 'AXTAR_NO_REMINDER';
export function defaultDeps() {
    return {
        env: process.env,
        cwd: process.cwd(),
        stateDir: defaultStateDir(),
        findRoot: findRepoRoot,
        readTree: readWorkTreeState,
        loadBinding: loadRepoBinding,
    };
}
/**
 * What the agent reads when the reminder fires.
 *
 * It names the tool, says what to do with the answer, and says out loud that
 * this is a one-shot — so an agent that cannot run the check (unbound repo,
 * engine down) reports that in a line and finishes, rather than looping trying
 * to satisfy a hook that will not ask again anyway.
 */
export const REMINDER_TEXT = [
    'This turn changed code in the working tree and no Axtar check has been run against it.',
    '',
    'Run axtar_check_diff now, then surface the receipt block it returns (check_id, url, summary)',
    'verbatim in your summary to the developer before you finish.',
    '',
    'If the check refuses or the platform cannot answer, say so in one line and finish anyway — the',
    'checks fail open and this reminder fires only once per unchecked change, so it will not ask',
    'again for this state.',
].join('\n');
/**
 * The ladder. Every rung but the last is an allow, and the last one records
 * that it nudged before it does.
 */
export async function decide(input, deps) {
    const off = deps.env[OFF_SWITCH_ENV];
    if (off !== undefined && off.trim().length > 0)
        return { kind: 'allow', reason: 'off_switch' };
    // A Stop hook already continued this turn: nudging again is how a hook loop
    // starts, and Claude Code sets this flag precisely so we do not.
    if (input.stop_hook_active === true)
        return { kind: 'allow', reason: 'stop_hook_active' };
    const start = input.cwd !== undefined && input.cwd.trim().length > 0 ? input.cwd : deps.cwd;
    const root = await deps.findRoot(start);
    if (!root.ok)
        return { kind: 'allow', reason: 'not_a_repo' };
    const repoRoot = root.value;
    // No binding, no opinion: Axtar does not govern this repo, and a reminder to
    // check against nothing is worse than silence.
    if (!deps.loadBinding(repoRoot).ok)
        return { kind: 'allow', reason: 'not_bound' };
    const tree = await deps.readTree(repoRoot);
    if (tree === null)
        return { kind: 'allow', reason: 'tree_unreadable' };
    if (!tree.dirty)
        return { kind: 'allow', reason: 'tree_clean' };
    const state = readState(repoRoot, deps.stateDir);
    if (state.last_checked_hash === tree.hash) {
        return { kind: 'allow', reason: 'already_checked' };
    }
    if (state.last_nudged_hash === tree.hash) {
        return { kind: 'allow', reason: 'already_nudged' };
    }
    // Recorded before it is spoken: if anything downstream fails, the worst case
    // is a reminder that was never delivered, not one that repeats every turn.
    writeState(repoRoot, { last_nudged_hash: tree.hash }, deps.stateDir);
    return { kind: 'nudge', reason: REMINDER_TEXT };
}
export function blockOutput(reason) {
    return { decision: 'block', reason };
}
/**
 * Parse the hook payload. Unparseable stdin is not an error worth surfacing —
 * an empty object walks the same ladder and lands on an allow.
 */
export function parseInput(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object')
            return {};
        const record = parsed;
        return {
            ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
            ...(typeof record.transcript_path === 'string'
                ? { transcript_path: record.transcript_path }
                : {}),
            ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
            ...(typeof record.hook_event_name === 'string'
                ? { hook_event_name: record.hook_event_name }
                : {}),
            ...(typeof record.stop_hook_active === 'boolean'
                ? { stop_hook_active: record.stop_hook_active }
                : {}),
        };
    }
    catch {
        return {};
    }
}
export async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}
/**
 * stdin → decision → at most one line of stdout. Always exits 0: this hook has
 * no failure mode that should read as a hook error to the host.
 */
export async function main() {
    const decision = await decide(parseInput(await readStdin()), defaultDeps());
    if (decision.kind === 'allow') {
        log.debug('turn-end reminder: allowing stop', { reason: decision.reason });
        return;
    }
    log.info('turn-end reminder: unchecked change in the working tree');
    process.stdout.write(`${JSON.stringify(blockOutput(decision.reason))}\n`);
}
// Start only when run as the entrypoint (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('check-reminder.js')) {
    main().catch((err) => {
        // Never let a bug here end a turn with a hook error: say it on stderr and
        // let the agent stop.
        process.stderr.write(`axtar turn-end reminder failed open: ${String(err)}\n`);
        process.exit(0);
    });
}
//# sourceMappingURL=check-reminder.js.map