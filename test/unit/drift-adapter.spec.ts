/**
 * v1 PostToolUse drift advisory (I1) — host adapter plumbing.
 *
 * The advisory is appended to the host's Post output without changing the
 * verdict's exit code, and the Pre path is left untouched. These tests pin:
 *   - claude-code: advisory appended to Post stderr; exit code identical to the
 *     render without an advisory; Pre render ignores the advisory.
 */

import { describe, expect, it } from 'vitest';

import { claudeCodeOutputAdapter } from '../../src/hosts/claude-code/adapter.js';
import type { RenderContext } from '../../src/shared/output/adapter.js';
import type { EvaluateResponse } from '../../src/shared/wire/schemas.js';

const REMINDER = 'REMINDER_X';

// A Post verdict that surfaces output (block → exit 2 on Post), so we can prove
// the advisory rides the existing render and the exit code is untouched.
const POST_BLOCK: EvaluateResponse = {
  verdict: 'block',
  violations: [
    {
      rule_id: 'AXT-ARC-1',
      severity: 'blocking',
      message: 'arch violation',
      foundation: null,
      fix_suggestion: null,
    },
  ],
  consult_required: true,
};

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

function ctx(over: Partial<RenderContext>): RenderContext {
  return { hook: 'PostToolUse', ruleNames: EMPTY_NAMES, ...over };
}

describe('claude-code adapter — drift advisory', () => {
  it('Post + driftAdvisory → advisory in stderr, exit code unchanged', () => {
    const withAdvisory = claudeCodeOutputAdapter.render(
      POST_BLOCK,
      ctx({ driftAdvisory: REMINDER }),
    );
    const without = claudeCodeOutputAdapter.render(POST_BLOCK, ctx({}));

    expect(withAdvisory.stderr).toContain(REMINDER);
    // The verdict body is still present (advisory appended, not replacing).
    expect(withAdvisory.stderr).toContain('arch violation');
    // The reminder never changes the verdict's exit code.
    expect(withAdvisory.exitCode).toBe(without.exitCode);
  });

  it('Pre + driftAdvisory → advisory NOT appended (Pre is untouched)', () => {
    const pre = claudeCodeOutputAdapter.render(
      { ...POST_BLOCK, verdict: 'pass', violations: [] },
      ctx({ hook: 'PreToolUse', driftAdvisory: REMINDER }),
    );
    expect(pre.stderr ?? '').not.toContain(REMINDER);
  });
});
