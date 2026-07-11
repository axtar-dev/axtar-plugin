/**
 * Minimal unified-diff producer. The engine consumes `request.diff` purely
 * as a string passed forward — Phase 2's Semgrep adapter doesn't read it,
 * the LLM adapter (Phase 5) will. So semantic correctness > exact `git diff`
 * formatting. We keep this small and dependency-free.
 */
const HUNK_CONTEXT = 3;
export function unifiedDiff(before, after, filePathBefore, filePathAfter) {
    if (before === after)
        return '';
    const a = before.split('\n');
    const b = after.split('\n');
    const ops = lcsDiff(a, b);
    const lines = [];
    lines.push(`--- a/${filePathBefore}`);
    lines.push(`+++ b/${filePathAfter}`);
    for (const hunk of groupHunks(ops, HUNK_CONTEXT)) {
        lines.push(`@@ -${hunk.aStart + 1},${hunk.aLen} +${hunk.bStart + 1},${hunk.bLen} @@`);
        for (const op of hunk.ops) {
            switch (op.tag) {
                case 'eq':
                    lines.push(` ${op.line}`);
                    break;
                case 'del':
                    lines.push(`-${op.line}`);
                    break;
                case 'add':
                    lines.push(`+${op.line}`);
                    break;
            }
        }
    }
    return lines.join('\n') + '\n';
}
function lcsDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            const row = dp[i];
            const next = dp[i + 1];
            if (a[i] === b[j]) {
                row[j] = next[j + 1] + 1;
            }
            else {
                row[j] = Math.max(next[j], row[j + 1]);
            }
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ tag: 'eq', line: a[i], aIdx: i, bIdx: j });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ tag: 'del', line: a[i], aIdx: i });
            i++;
        }
        else {
            ops.push({ tag: 'add', line: b[j], bIdx: j });
            j++;
        }
    }
    while (i < n) {
        ops.push({ tag: 'del', line: a[i], aIdx: i });
        i++;
    }
    while (j < m) {
        ops.push({ tag: 'add', line: b[j], bIdx: j });
        j++;
    }
    return ops;
}
function groupHunks(ops, context) {
    const hunks = [];
    let i = 0;
    while (i < ops.length) {
        if (ops[i].tag === 'eq') {
            i++;
            continue;
        }
        let start = Math.max(0, i - context);
        while (start > 0 && ops[start - 1].tag === 'eq' && i - start < context) {
            start--;
        }
        let end = i;
        while (end < ops.length) {
            if (ops[end].tag === 'eq') {
                let runEnd = end;
                while (runEnd < ops.length && ops[runEnd].tag === 'eq')
                    runEnd++;
                if (runEnd - end > 2 * context && runEnd < ops.length) {
                    end = end + context;
                    break;
                }
                end = runEnd;
            }
            else {
                end++;
            }
        }
        const hunkOps = ops.slice(start, end);
        const first = hunkOps[0];
        const aStart = first.tag === 'add' ? first.bIdx : first.aIdx;
        const bStart = first.tag === 'del' ? first.aIdx : first.bIdx;
        let aLen = 0;
        let bLen = 0;
        for (const op of hunkOps) {
            if (op.tag === 'eq' || op.tag === 'del')
                aLen++;
            if (op.tag === 'eq' || op.tag === 'add')
                bLen++;
        }
        hunks.push({ aStart, aLen, bStart, bLen, ops: hunkOps });
        i = end;
    }
    return hunks;
}
//# sourceMappingURL=diff.js.map