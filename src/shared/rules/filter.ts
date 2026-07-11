/**
 * Plugin-side rule pre-filter (D-020). Mirrors the gitignore-glob semantics
 * implemented in `engine/src/axtar_engine/detection/router.py::_glob_to_regex`
 * exactly. Drift between the two implementations is a silent correctness bug.
 *
 * Semantics:
 *   - `**\/` matches any (possibly empty) path prefix
 *   - `\/**` at end matches any path suffix
 *   - `**`  standalone matches anything (including `/`)
 *   - `*`   matches anything except `/`
 *   - `?`   matches one character except `/`
 *   - everything else is escaped literal
 */

import type { Altitude, RuleSummary, Severity } from '../wire/schemas.js';

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.java': 'java',
};

export function languageForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
}

export function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return true;
  return globs.some((g) => globToRegex(g).test(filePath));
}

const regexCache = new Map<string, RegExp>();

export function globToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  const out: string[] = [];
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    if (pattern.startsWith('**/', i)) {
      out.push('(?:.*/)?');
      i += 3;
    } else if (pattern.startsWith('/**', i) && i + 3 === n) {
      out.push('(?:/.*)?');
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      out.push('.*');
      i += 2;
    } else {
      const ch = pattern[i] as string;
      if (ch === '*') {
        out.push('[^/]*');
      } else if (ch === '?') {
        out.push('[^/]');
      } else {
        out.push(escapeRegex(ch));
      }
      i += 1;
    }
  }
  const compiled = new RegExp(`^${out.join('')}$`);
  regexCache.set(pattern, compiled);
  return compiled;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface FilterOptions {
  severities: ReadonlySet<Severity>;
  // Mentor gate carve-out (v1 bug fix). Rules whose `altitude` is in this set
  // bypass the severity filter so they always reach /evaluate and the server
  // can compute `consult_required` — the gate trigger is altitude-only,
  // independent of severity. The Pre prefilter passes `HIGH_ALTITUDES`; the
  // Post prefilter omits it. Carve-out rules STILL must pass language + path
  // applicability — a high-altitude rule that doesn't apply to the file must
  // not fire the gate (mirrors the server's `applicable_rules`).
  //
  // Single-engine product (D-046/D-049): the former per-engine partition
  // dimension was removed — every rule is `llm`, so there is nothing to filter
  // by engine. This carve-out is the sole Pre-path gate-forwarding mechanism.
  gateAltitudes?: ReadonlySet<Altitude>;
}

export function filterRules(
  rules: readonly RuleSummary[],
  filePath: string,
  options: FilterOptions,
): RuleSummary[] {
  const language = languageForPath(filePath);
  const out: RuleSummary[] = [];
  for (const rule of rules) {
    const isGateRule =
      options.gateAltitudes !== undefined && options.gateAltitudes.has(rule.altitude);
    if (!isGateRule) {
      if (!options.severities.has(rule.severity)) continue;
    }
    if (language !== undefined && rule.language !== language) continue;
    if (!matchesAnyGlob(filePath, rule.paths)) continue;
    out.push(rule);
  }
  return out;
}
