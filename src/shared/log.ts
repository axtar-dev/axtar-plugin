/**
 * stderr-only structured logger. Stdout is reserved for Claude Code; anything
 * we print to stdout risks being misinterpreted as hook output. Keep this
 * extremely small — the hook is on the latency-critical path.
 *
 * Also home to the diagnostic file-trace facility (`trace`, gated on
 * `AXTAR_HOOK_TRACE="true"`). Lives here because it's the second diagnostic
 * concern alongside structured logging, and de-duplicating it out of
 * `runner.ts` and `rules/cache.ts` was the one piece of real work folded into
 * the Step 11.5.1a shared-tree move (per `DECISIONS.md` D-039 commit notes).
 */

import { appendFileSync } from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function activeLevel(): Level {
  const env = (process.env.AXTAR_LOG_LEVEL ?? 'info').toLowerCase();
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return env;
  }
  return 'info';
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (levelOrder[level] < levelOrder[activeLevel()]) {
    return;
  }
  const prefix = `axtar[${level}]`;
  if (fields && Object.keys(fields).length > 0) {
    process.stderr.write(`${prefix} ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stderr.write(`${prefix} ${message}\n`);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

// ───────────────────────────────────────────────────────────────────────────
// Diagnostic file trace — `AXTAR_HOOK_TRACE="true"` opts in. Off by default;
// when unset, `trace()` is a single boolean compare per call site, no
// formatting, no fs syscall. The §8 sub-500ms SLA sees zero cost.
//
// Originally lived inline in `runner.ts` and `rules/cache.ts` (two
// independent copies). Folded here as part of Step 11.5.1a's shared-tree
// move so both call sites import the same helper. The runner.ts variant's
// `formatValue` (truncates long strings, single-lines them) wins as
// canonical; outputs match the prior `JSON.stringify` form in cache.ts for
// the simple values cache events pass.
// ───────────────────────────────────────────────────────────────────────────

export const TRACE_ENABLED = process.env.AXTAR_HOOK_TRACE === 'true';
const TRACE_PATH = '/tmp/axtar-hook-trace.log';

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') {
    // Keep values single-line so each trace entry stays one line.
    const cleaned = v.replace(/\s+/g, ' ');
    return cleaned.length > 200 ? `"${cleaned.slice(0, 200)}…"` : `"${cleaned}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function trace(label: string, fields: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  try {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${formatValue(v)}`);
    const line = `[${new Date().toISOString()}] ${label}${parts.length > 0 ? ' ' + parts.join(' ') : ''}\n`;
    appendFileSync(TRACE_PATH, line);
  } catch {
    // Tracer must never break the hook. Swallow tracer-internal errors.
  }
}

// Convenience for entrypoint top-of-module markers and crash-capture sites:
// gated identical-shape line-emit that does not require building a fields
// record. Equivalent to `if (TRACE_ENABLED) { try { appendFileSync(...) }
// catch {} }` inlined at each call site.
export function traceRaw(line: string): void {
  if (!TRACE_ENABLED) return;
  try {
    appendFileSync(TRACE_PATH, line);
  } catch {
    // Tracer must never break the hook.
  }
}
