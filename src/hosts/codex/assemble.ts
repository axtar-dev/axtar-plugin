/**
 * Map a codex hook stdin payload to a `PreToolUseRequest`, parallel to
 * the Claude Code assemble. Returns a discriminated outcome:
 *
 *   - `{ kind: 'evaluate', request }` — caller should POST to engine
 *   - `{ kind: 'skip', reason }`     — caller exits 0; engine call
 *                                       would be meaningless
 *   - `{ kind: 'invalid', detail }`  — host gave us an unparseable
 *                                       payload
 *
 * Dispatch:
 *   - tool_name === 'apply_patch' →
 *       Pre:  parse the patch envelope, simulate (Add File: trivial;
 *             Update File: apply hunks to on-disk file_before;
 *             Delete File: file_after = ''), produce unified diff.
 *       Post: parse the patch envelope for file_path, read disk
 *             (file already landed).
 *   - any other tool_name → skip (codex's other tools — Bash,
 *       MCP-filesystem-writes, structured shell — surface in 11.5.5's
 *       matcher widening; this step gates `^apply_patch$` only).
 *
 * Wire shape (see [[D-044]] — empirically captured against codex 0.133.0,
 * matches docs at https://developers.openai.com/codex/hooks and the PR
 * that first wired apply_patch into the hook surface,
 * https://github.com/openai/codex/pull/18391):
 *
 *   tool_name:   "apply_patch"
 *   tool_input:  { command: "<full patch envelope as a single string>" }
 *
 * No `file_path` at the top of `tool_input` — the path lives inside the
 * envelope per `*** Update File: <path>` / `*** Add File: <path>` /
 * `*** Delete File: <path>`. Codex deliberately mirrored Bash's shape
 * (single `command` string field) for apply_patch when PR #18391 landed,
 * so generic Bash-style matchers continue to work. The generated wire
 * schema declares `tool_input: true` (any JSON) — the prose docs and PR
 * are the contract.
 *
 * apply_patch envelope format (codex's canonical form):
 *
 *   *** Begin Patch
 *   *** Update File: path/to/file.ext         (or Add File: / Delete File:)
 *   @@ <context anchor>                       (optional; for Update)
 *    unchanged context line
 *   -removed line
 *   +added line
 *    unchanged context line
 *   *** End Patch
 *
 * Multi-file patches are supported by the format; this implementation
 * processes only the FIRST file operation per call (the demo and the
 * common case). Multi-file patches surface a `skip` with a clear reason;
 * a multi-file follow-up is a separate scoped change if 11.5.6 reveals
 * demand.
 *
 * The `@@ <context>` anchor (no line numbers) is codex-specific —
 * standard unified diff uses `@@ -old,N +new,M @@` instead. Most codex
 * hunks ship a *bare* `@@` (no trailing anchor text) and rely on the
 * surrounding context+removal lines to locate themselves. Codex's own
 * applier (codex-rs/apply-patch: `compute_replacements` / `seek_sequence`)
 * is sequence-match-based, not fixed-offset: for each hunk it builds a
 * needle (context+removal lines) and a replacement (context+addition
 * lines), seeks the needle in the working file starting at a cursor that
 * advances across hunks, and substitutes. Bare `@@` searches from the
 * current cursor; `@@ <text>` narrows the start by first locating the
 * anchor line. See [[D-045]] for why we ported this algorithm in-tree
 * (and why the 11.5.4 fixed-offset stand-in shipped broken).
 *
 * `file_path` is resolved against `cwd` from the codex hook payload
 * (mapped through the shared HookInput) when relative.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { unifiedDiff } from '../../shared/edit/diff.js';
import type { HookInput } from '../../shared/hook-input.js';
import {
  HIGH_ALTITUDES,
  type AssembleOutcome,
  type WrapperOptions,
} from '../../shared/payload-types.js';
import { filterRules, type FilterOptions } from '../../shared/rules/filter.js';
import type { Altitude, RuleSummary, Severity } from '../../shared/wire/schemas.js';

export type { AssembleOutcome, WrapperOptions };

interface AssembleOptions {
  rules: readonly RuleSummary[];
  severities: ReadonlySet<Severity>;
  projectDir: string;
  hookKind: 'pre' | 'post';
  // Mentor gate carve-out altitudes — see claude-code/assemble.ts. The Pre
  // wrapper injects `HIGH_ALTITUDES`; the Post wrapper leaves it undefined.
  gateAltitudes?: ReadonlySet<Altitude>;
}

function resolvePath(filePath: string, projectDir: string): string {
  return isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
}

// Build `filterRules` options from the assemble options — single source so the
// Pre and Post apply_patch call sites cannot drift on engine/gate-altitude.
function ruleFilterOptions(options: AssembleOptions): FilterOptions {
  return {
    severities: options.severities,
    ...(options.gateAltitudes === undefined ? {} : { gateAltitudes: options.gateAltitudes }),
  };
}

type PatchOp =
  | { kind: 'update'; file_path: string; hunks: PatchHunk[] }
  | { kind: 'add'; file_path: string; content: string }
  | { kind: 'delete'; file_path: string };

interface PatchHunk {
  // Optional context anchor from `@@ <text>`. Empty string when the
  // hunk had no anchor (rare; treated as "match at beginning").
  anchor: string;
  // Lines in the hunk, each prefixed with ' ', '-', or '+'.
  lines: string[];
}

function parseApplyPatch(patch: string): PatchOp[] | { error: string } {
  const lines = patch.split('\n');
  let i = 0;

  // Tolerate a leading blank, then require the begin marker.
  while (i < lines.length && lines[i] === '') i += 1;
  if (i >= lines.length || lines[i] !== '*** Begin Patch') {
    return { error: 'missing *** Begin Patch marker' };
  }
  i += 1;

  const ops: PatchOp[] = [];

  while (i < lines.length) {
    const line = lines[i];
    if (line === '*** End Patch') {
      return ops;
    }
    const updateMatch = line?.match(/^\*\*\* Update File:\s*(.+)$/);
    const addMatch = line?.match(/^\*\*\* Add File:\s*(.+)$/);
    const deleteMatch = line?.match(/^\*\*\* Delete File:\s*(.+)$/);

    if (deleteMatch) {
      ops.push({ kind: 'delete', file_path: deleteMatch[1]!.trim() });
      i += 1;
      continue;
    }

    if (addMatch) {
      const file_path = addMatch[1]!.trim();
      i += 1;
      const collected: string[] = [];
      while (i < lines.length && lines[i] !== '*** End Patch' && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          collected.push(l.slice(1));
        } else if (l === '') {
          collected.push('');
        } else {
          return { error: `Add File '${file_path}': unexpected line ${JSON.stringify(l)}` };
        }
        i += 1;
      }
      ops.push({ kind: 'add', file_path, content: collected.join('\n') });
      continue;
    }

    if (updateMatch) {
      const file_path = updateMatch[1]!.trim();
      i += 1;
      const hunks: PatchHunk[] = [];
      while (i < lines.length && lines[i] !== '*** End Patch' && !lines[i]!.startsWith('*** ')) {
        const hunkHeader = lines[i]!.match(/^@@\s*(.*)$/);
        if (hunkHeader) {
          const anchor = hunkHeader[1]!.trim();
          i += 1;
          const hunkLines: string[] = [];
          while (
            i < lines.length &&
            lines[i] !== '*** End Patch' &&
            !lines[i]!.startsWith('*** ') &&
            !lines[i]!.match(/^@@/)
          ) {
            hunkLines.push(lines[i]!);
            i += 1;
          }
          hunks.push({ anchor, lines: hunkLines });
        } else if (lines[i] === '') {
          // tolerate stray blanks between hunks
          i += 1;
        } else {
          return {
            error: `Update File '${file_path}': expected '@@' hunk header at line ${JSON.stringify(lines[i])}`,
          };
        }
      }
      ops.push({ kind: 'update', file_path, hunks });
      continue;
    }

    return { error: `unexpected directive: ${JSON.stringify(line)}` };
  }

  return { error: 'missing *** End Patch marker' };
}

// Find the first index `i >= startIdx` such that
// `haystack[i .. i+needle.length]` equals `needle` element-for-element.
// Returns -1 if no match. Empty needles match trivially at `startIdx`.
//
// Mirrors codex's `seek_sequence` (codex-rs/apply-patch/src/lib.rs): the
// match is element-exact, not fixed-offset, so a hunk built from a
// distinctive context+removal block locates itself by content rather
// than by line number — which is essential for bare-`@@` hunks and for
// disambiguating repeated lines via surrounding context.
function seekSequence(haystack: string[], needle: string[], startIdx: number): number {
  if (needle.length === 0) return startIdx;
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, startIdx); i <= last; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function applyUpdate(fileBefore: string, hunks: PatchHunk[]): string | { error: string } {
  let workingLines = fileBefore.split('\n');
  // Cursor threads forward across hunks. Each successful hunk advances
  // it past the just-substituted region, so later hunks searching from
  // `cursor` cannot accidentally match earlier text — that's how multi-
  // hunk patches with two `@@` blocks under one `*** Update File:` stay
  // ordered.
  let cursor = 0;

  for (const hunk of hunks) {
    const result = applyHunk(workingLines, hunk, cursor);
    if ('error' in result) return result;
    workingLines = result.lines;
    cursor = result.nextCursor;
  }
  return workingLines.join('\n');
}

function applyHunk(
  workingLines: string[],
  hunk: PatchHunk,
  cursor: number,
): { lines: string[]; nextCursor: number } | { error: string } {
  // Build the needle (context + removal lines) and replacement (context
  // + addition lines). Empty hunk lines (length 0) are treated as
  // context-empty; the canonical codex form for an empty context line
  // is the single-space prefix `' '` (which after slice(1) is also ''),
  // but tolerating a literal '' keeps us robust against pre-stripped
  // patch text.
  const needle: string[] = [];
  const replacement: string[] = [];

  for (const line of hunk.lines) {
    if (line === '') {
      needle.push('');
      replacement.push('');
      continue;
    }
    const op = line[0];
    const content = line.slice(1);
    if (op === ' ') {
      needle.push(content);
      replacement.push(content);
    } else if (op === '-') {
      needle.push(content);
    } else if (op === '+') {
      replacement.push(content);
    } else {
      return { error: `unexpected hunk line operator ${JSON.stringify(op)}` };
    }
  }

  // Determine the starting position for the needle search. With no
  // anchor (the common bare-`@@` case), search from the threading
  // cursor. With an anchor, find the anchor line first (also from the
  // cursor, so a repeated anchor downstream of an earlier hunk doesn't
  // bind upstream), then start the needle search on the line *after*
  // the anchor — codex's `@@` text names the enclosing scope, not the
  // first content line of the hunk.
  let searchStart = cursor;
  if (hunk.anchor !== '') {
    const wantedAnchor = hunk.anchor.trim();
    let anchorIdx = -1;
    for (let i = cursor; i < workingLines.length; i += 1) {
      if (workingLines[i]!.trim() === wantedAnchor) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx < 0) {
      return {
        error: `hunk anchor not found from cursor ${cursor}: ${JSON.stringify(hunk.anchor)}`,
      };
    }
    searchStart = anchorIdx + 1;
  }

  const matchIdx = seekSequence(workingLines, needle, searchStart);
  if (matchIdx < 0) {
    return {
      error: `hunk content not found from index ${searchStart} (needle length ${needle.length})`,
    };
  }

  const output = [
    ...workingLines.slice(0, matchIdx),
    ...replacement,
    ...workingLines.slice(matchIdx + needle.length),
  ];
  return { lines: output, nextCursor: matchIdx + replacement.length };
}

function assembleApplyPatch(input: HookInput, options: AssembleOptions): AssembleOutcome {
  const patch = (input.tool_input as Record<string, unknown>).command;
  if (typeof patch !== 'string' || patch.length === 0) {
    return { kind: 'invalid', detail: 'apply_patch tool_input.command missing or not a string' };
  }

  const parsed = parseApplyPatch(patch);
  if ('error' in parsed) {
    return { kind: 'invalid', detail: `apply_patch parse: ${parsed.error}` };
  }
  if (parsed.length === 0) {
    return { kind: 'skip', reason: 'apply_patch: empty patch' };
  }
  if (parsed.length > 1) {
    return {
      kind: 'skip',
      reason: `apply_patch: multi-file patch (${parsed.length} ops); single-file only in 11.5.4`,
    };
  }
  const op = parsed[0]!;
  const filePath = resolvePath(op.file_path, options.projectDir);

  if (options.hookKind === 'post') {
    if (!existsSync(filePath)) {
      return { kind: 'skip', reason: 'PostToolUse: file not found on disk' };
    }
    const fileAfter = readFileSync(filePath, 'utf-8');
    const ruleSet = filterRules(options.rules, filePath, ruleFilterOptions(options)).map(
      (r) => r.id,
    );
    return {
      kind: 'evaluate',
      request: {
        session_id: input.session_id,
        tool: 'apply_patch',
        file_path: filePath,
        diff: '',
        file_after: fileAfter,
        rule_set: ruleSet,
        gate_check: false,
      },
    };
  }

  // Pre: simulate.
  let fileBefore: string;
  let fileAfter: string;

  if (op.kind === 'add') {
    if (existsSync(filePath)) {
      return {
        kind: 'invalid',
        detail: `apply_patch Add File '${op.file_path}' but file already exists on disk`,
      };
    }
    fileBefore = '';
    fileAfter = op.content;
  } else if (op.kind === 'delete') {
    if (!existsSync(filePath)) {
      return { kind: 'skip', reason: 'apply_patch Delete File: target does not exist' };
    }
    fileBefore = readFileSync(filePath, 'utf-8');
    fileAfter = '';
  } else {
    // update
    if (!existsSync(filePath)) {
      return {
        kind: 'invalid',
        detail: `apply_patch Update File '${op.file_path}' but target missing on disk`,
      };
    }
    fileBefore = readFileSync(filePath, 'utf-8');
    const applied = applyUpdate(fileBefore, op.hunks);
    if (typeof applied !== 'string') {
      return {
        kind: 'invalid',
        detail: `apply_patch Update File '${op.file_path}': ${applied.error}`,
      };
    }
    fileAfter = applied;
  }

  const ruleSet = filterRules(options.rules, filePath, ruleFilterOptions(options)).map((r) => r.id);

  return {
    kind: 'evaluate',
    request: {
      session_id: input.session_id,
      tool: 'apply_patch',
      file_path: filePath,
      diff: unifiedDiff(fileBefore, fileAfter, filePath, filePath),
      file_after: fileAfter,
      rule_set: ruleSet,
      gate_check: true,
    },
  };
}

function assemble(input: HookInput, options: AssembleOptions): AssembleOutcome {
  const tool = input.tool_name;
  if (tool === 'apply_patch') {
    return assembleApplyPatch(input, options);
  }
  // The 11.5.5 matcher widening (per D-041 Group A) added Bash and MCP
  // filesystem-write tools to the codex hook matcher. The hook now FIRES
  // on those tools but the engine has no content-level Bash-lane
  // evaluation yet (deferred per D-042-placeholder). Logs-and-allows-
  // through: returns `skip`, the runner traces `assemble.skip` and exits
  // 0. Closes the matcher visibility gap; content-level blocking on
  // Bash/MCP-write follows when D-042 resolves.
  if (tool === 'Bash' || tool.startsWith('mcp__')) {
    return {
      kind: 'skip',
      reason: `tool ${tool} matched (D-041 widening) but engine Bash-lane / MCP-write evaluation is deferred (D-042-placeholder)`,
    };
  }
  return { kind: 'skip', reason: `tool ${tool} is not gated by Axtar on codex` };
}

export function assembleForPre(input: HookInput, options: WrapperOptions): AssembleOutcome {
  return assemble(input, {
    ...options,
    hookKind: 'pre',
    gateAltitudes: HIGH_ALTITUDES,
  });
}

export function assembleForPost(input: HookInput, options: WrapperOptions): AssembleOutcome {
  return assemble(input, { ...options, hookKind: 'post' });
}
