/**
 * "Has this working tree been checked?" — the one fingerprint, and the state
 * file it is remembered in.
 *
 * The turn-end reminder (`src/hooks/check-reminder.ts`) and the checks MCP
 * server both need an answer to the same question, so both get it from here.
 * If the hook hashed the tree one way and the server marked it another, the
 * marker would never match: the reminder would fire after every single turn,
 * which is precisely the nagging this design exists to avoid. **One module, one
 * hash.**
 *
 * **What the fingerprint covers.** `git status --porcelain=v1 -z
 * --untracked-files=all` (which paths are modified, staged, deleted, untracked)
 * plus `git diff HEAD` (the content of every tracked change, staged and
 * unstaged alike — plain `git diff` would miss work that was `git add`ed after
 * the last check). Both go through `execFile` with an argv list, the same
 * discipline as `producer.ts`: no shell, so a path with a `;` in it is a path.
 *
 * **What it deliberately does not cover:** the *contents* of untracked files.
 * A new file appearing changes the status output, but editing it again after a
 * check does not change the hash. That is the safe direction to be wrong in —
 * this fingerprint only ever decides whether to *nudge*, and a missed nudge
 * costs a reminder while a spurious one costs the developer's attention every
 * turn.
 *
 * **The state lives outside the repository.** `~/.axtar/state/<sha256 of the
 * repo root path>.json` — never inside the bound repo, which the plugin does
 * not write to at all (CLAUDE.md invariant #5). Nothing here throws: a corrupt
 * file, an unwritable home directory or a missing git are all "we do not know",
 * and not knowing means the reminder stays quiet.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { log } from './log.js';
const execFileAsync = promisify(execFile);
/** A whole-tree diff of a large change is large; the cap is a guard, not a budget. */
const MAX_GIT_BUFFER = 256 * 1024 * 1024;
/** Nothing known yet — the answer for a repo with no state file, and for a corrupt one. */
export const EMPTY_STATE = {
    last_checked_hash: null,
    last_nudged_hash: null,
    updated_at: null,
};
async function git(cwd, args) {
    try {
        const { stdout } = await execFileAsync('git', [...args], {
            cwd,
            encoding: 'utf-8',
            maxBuffer: MAX_GIT_BUFFER,
            // Reading a work tree must never take (or wait for) the index lock.
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        });
        return { ok: true, stdout };
    }
    catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}
/**
 * The tree's fingerprint plus whether it is dirty at all, or null when
 * `repoRoot` is not a git work tree (or git is not installed).
 *
 * `git diff HEAD` is skipped on a repository with no commits — there is no HEAD
 * to diff against, and everything in such a tree is untracked and already named
 * by the status output.
 */
export async function readWorkTreeState(repoRoot) {
    const status = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!status.ok) {
        log.debug('work tree state unavailable', { repoRoot, detail: status.detail });
        return null;
    }
    const head = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const diff = head.ok
        ? await git(repoRoot, ['diff', 'HEAD', '--'])
        : { ok: true, stdout: '' };
    if (!diff.ok) {
        log.debug('work tree diff unavailable', { repoRoot, detail: diff.detail });
        return null;
    }
    const hash = createHash('sha256')
        .update('axtar-tree-state-v1\0')
        .update(status.stdout)
        .update('\0')
        .update(diff.stdout)
        .digest('hex');
    return { hash, dirty: status.stdout.length > 0 || diff.stdout.length > 0 };
}
/** The fingerprint alone — what the server stamps after a check. Null off a work tree. */
export async function workTreeStateHash(repoRoot) {
    const state = await readWorkTreeState(repoRoot);
    return state === null ? null : state.hash;
}
// --- the state file ----------------------------------------------------------
/** `~/.axtar/state` — outside every repository, on purpose. */
export function defaultStateDir(home = homedir()) {
    return join(home, '.axtar', 'state');
}
/**
 * The state file for one repository: the repo root's absolute path, hashed.
 *
 * Hashed rather than slugified so the name is fixed-length and carries no part
 * of a path that might be private, and so two checkouts of the same project at
 * different paths keep separate state — which is what a worktree is.
 */
export function stateFilePath(repoRoot, stateDir = defaultStateDir()) {
    const key = createHash('sha256').update(resolve(repoRoot)).digest('hex');
    return join(stateDir, `${key}.json`);
}
function asText(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
/** What is remembered about `repoRoot`. Absent or corrupt reads as "nothing". */
export function readState(repoRoot, stateDir = defaultStateDir()) {
    const path = stateFilePath(repoRoot, stateDir);
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        // Missing is the normal case (first run); unparseable means a half-written
        // file we simply do not trust. Both mean the same thing: nothing is known.
        return EMPTY_STATE;
    }
    if (raw === null || typeof raw !== 'object')
        return EMPTY_STATE;
    const record = raw;
    return {
        last_checked_hash: asText(record.last_checked_hash),
        last_nudged_hash: asText(record.last_nudged_hash),
        updated_at: asText(record.updated_at),
    };
}
/**
 * Merge `patch` into `repoRoot`'s state. Never throws — an unwritable home
 * directory must not take down a check or block a turn from ending.
 */
export function writeState(repoRoot, patch, stateDir = defaultStateDir()) {
    const path = stateFilePath(repoRoot, stateDir);
    const next = {
        ...readState(repoRoot, stateDir),
        ...patch,
        updated_at: new Date().toISOString(),
    };
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    }
    catch (err) {
        log.debug('could not persist reminder state', {
            path,
            detail: err instanceof Error ? err.message : String(err),
        });
    }
}
/**
 * Stamp the current tree as checked — what a successful `axtar_check_diff` /
 * `axtar_check_scan` leaves behind so the turn-end reminder stays quiet.
 *
 * Never throws, and does nothing at all when the hash cannot be taken: a check
 * that ran outside a work tree has nothing to vouch for.
 */
export async function markWorkTreeChecked(repoRoot, stateDir = defaultStateDir()) {
    const hash = await workTreeStateHash(repoRoot);
    if (hash === null)
        return;
    writeState(repoRoot, { last_checked_hash: hash }, stateDir);
    log.debug('work tree marked as checked', { repoRoot, hash });
}
//# sourceMappingURL=tree-state.js.map