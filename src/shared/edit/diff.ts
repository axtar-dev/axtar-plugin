/**
 * Minimal unified-diff producer. The engine consumes `request.diff` purely
 * as a string passed forward — Phase 2's Semgrep adapter doesn't read it,
 * the LLM adapter (Phase 5) will. So semantic correctness > exact `git diff`
 * formatting. We keep this small and dependency-free.
 */

const HUNK_CONTEXT = 3;

export function unifiedDiff(
  before: string,
  after: string,
  filePathBefore: string,
  filePathAfter: string,
): string {
  if (before === after) return '';

  const a = before.split('\n');
  const b = after.split('\n');
  const ops = lcsDiff(a, b);

  const lines: string[] = [];
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

type Op =
  | { tag: 'eq'; line: string; aIdx: number; bIdx: number }
  | { tag: 'del'; line: string; aIdx: number }
  | { tag: 'add'; line: string; bIdx: number };

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      const next = dp[i + 1] as number[];
      if (a[i] === b[j]) {
        row[j] = (next[j + 1] as number) + 1;
      } else {
        row[j] = Math.max(next[j] as number, row[j + 1] as number);
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'eq', line: a[i] as string, aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) {
      ops.push({ tag: 'del', line: a[i] as string, aIdx: i });
      i++;
    } else {
      ops.push({ tag: 'add', line: b[j] as string, bIdx: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ tag: 'del', line: a[i] as string, aIdx: i });
    i++;
  }
  while (j < m) {
    ops.push({ tag: 'add', line: b[j] as string, bIdx: j });
    j++;
  }
  return ops;
}

interface Hunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  ops: Op[];
}

function groupHunks(ops: Op[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if ((ops[i] as Op).tag === 'eq') {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    while (start > 0 && (ops[start - 1] as Op).tag === 'eq' && i - start < context) {
      start--;
    }
    let end = i;
    while (end < ops.length) {
      if ((ops[end] as Op).tag === 'eq') {
        let runEnd = end;
        while (runEnd < ops.length && (ops[runEnd] as Op).tag === 'eq') runEnd++;
        if (runEnd - end > 2 * context && runEnd < ops.length) {
          end = end + context;
          break;
        }
        end = runEnd;
      } else {
        end++;
      }
    }
    const hunkOps = ops.slice(start, end);
    const first = hunkOps[0] as Op;
    const aStart = first.tag === 'add' ? (first.bIdx as number) : (first.aIdx as number);
    const bStart = first.tag === 'del' ? (first.aIdx as number) : (first.bIdx as number);
    let aLen = 0;
    let bLen = 0;
    for (const op of hunkOps) {
      if (op.tag === 'eq' || op.tag === 'del') aLen++;
      if (op.tag === 'eq' || op.tag === 'add') bLen++;
    }
    hunks.push({ aStart, aLen, bStart, bLen, ops: hunkOps });
    i = end;
  }
  return hunks;
}
