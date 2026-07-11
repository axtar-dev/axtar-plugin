/**
 * Per-process /rules cache. Each hook invocation is a short-lived Node
 * process under Claude Code, so the "cache" is in practice a single GET
 * per hook. Keeping a TTL anyway in case future phases run the hook from
 * a longer-lived host (MCP server) — but Phase 3 always pays one round
 * trip per hook fire.
 *
 * Diagnostic trace (`AXTAR_HOOK_TRACE="true"`) is opt-in. The `trace`
 * helper is now imported from `../log.js` (deduped from runner.ts in
 * Step 11.5.1a's shared-tree move).
 */

import type { EngineClient } from '../engine/client.js';
import type { RuleSummary } from '../wire/schemas.js';
import { trace } from '../log.js';

export interface RulesCache {
  /**
   * Fetch the rule listing. `projectId` (the repo's selected project, from
   * `.axtar/config.json`) scopes the listing server-side when present.
   */
  fetch(projectId?: string): Promise<RuleSummary[] | null>;
}

const TTL_MS = 60_000;

export function createRulesCache(client: EngineClient): RulesCache {
  let cached: { at: number; rules: RuleSummary[]; projectId: string | undefined } | null = null;

  return {
    async fetch(projectId?: string): Promise<RuleSummary[] | null> {
      const now = Date.now();
      if (cached && cached.projectId === projectId && now - cached.at < TTL_MS) {
        trace('rules.cache.hit', { count: cached.rules.length, age_ms: now - cached.at });
        return cached.rules;
      }
      const result = await client.listRules(projectId);
      if (!result.ok) {
        trace('rules.cache.miss.error', { reason: result.reason, detail: result.detail });
        return null;
      }
      cached = { at: now, rules: result.value, projectId };
      trace('rules.cache.miss.ok', { count: result.value.length });
      return result.value;
    },
  };
}
