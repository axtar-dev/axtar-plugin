/**
 * Simulate `Edit` and `Write` to compute `file_after` **for PreToolUse only**.
 * PreToolUse fires BEFORE the edit lands on disk, so we mirror Claude Code's
 * documented semantics in memory.
 *
 * **PostToolUse takes a different path** (Step 10.7 fix). The edit has
 * already landed, so the post-edit file IS already on disk. The Post path
 * bypasses this simulator and reads `file_after` directly via
 * `readFileSync` in `payload/assemble.ts:assemblePostObserve`. Calling
 * `applyEdit` on Post would deterministically return `old_string_not_found`
 * because the on-disk file no longer contains `old_string` — Step 10.7
 * rehearsal surfaced this bug, latent since 10.4 (`5770e44`) introduced
 * `assembleForPost` and routed both wrappers through this Pre simulator.
 * Keep this module narrow: Pre simulates, Post observes; this file owns
 * the simulation, `assemble.ts` owns the observation.
 *
 * Edit semantics (per Claude Code docs):
 *   - `old_string` must be unique in the file unless `replace_all` is true.
 *   - Ambiguous `old_string` with `replace_all=false` is an error from
 *     Claude Code's own validation, not ours — we surface it as an
 *     `ambiguous_old_string` outcome and let the caller skip evaluation
 *     (Claude Code will reject the call regardless).
 *   - File must already exist for Edit.
 *
 * Write semantics:
 *   - `content` replaces the entire file. If the file did not exist,
 *     `file_before = ""`.
 */
import { readFileSync, existsSync } from 'node:fs';
export function applyEdit(input) {
    if (!existsSync(input.file_path)) {
        return { kind: 'file_not_found' };
    }
    const fileBefore = readFileSync(input.file_path, 'utf-8');
    if (input.replace_all === true) {
        if (!fileBefore.includes(input.old_string)) {
            return { kind: 'old_string_not_found' };
        }
        const fileAfter = fileBefore.split(input.old_string).join(input.new_string);
        return { kind: 'ok', file_before: fileBefore, file_after: fileAfter };
    }
    const first = fileBefore.indexOf(input.old_string);
    if (first < 0) {
        return { kind: 'old_string_not_found' };
    }
    const second = fileBefore.indexOf(input.old_string, first + input.old_string.length);
    if (second >= 0) {
        return { kind: 'ambiguous_old_string' };
    }
    const fileAfter = fileBefore.slice(0, first) +
        input.new_string +
        fileBefore.slice(first + input.old_string.length);
    return { kind: 'ok', file_before: fileBefore, file_after: fileAfter };
}
export function applyWrite(input) {
    const fileBefore = existsSync(input.file_path) ? readFileSync(input.file_path, 'utf-8') : '';
    return { kind: 'ok', file_before: fileBefore, file_after: input.content };
}
//# sourceMappingURL=apply.js.map