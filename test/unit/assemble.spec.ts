import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assemble,
  assembleForPre,
  assembleForPost,
  parseHookInput,
} from '../../src/hosts/claude-code/assemble.js';
import type { RuleSummary } from '../../src/shared/wire/schemas.js';

const moneyRule: RuleSummary = {
  id: 'AXT-JAVA-042',
  name: 'money',
  altitude: 'implementation',
  severity: 'blocking',
  language: 'java',
  paths: ['**/domain/**/*.java'],
};

const printlnRule: RuleSummary = {
  id: 'AXT-JAVA-077',
  name: 'no println',
  altitude: 'convention',
  severity: 'warning',
  language: 'java',
  paths: [],
};

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'axtar-assemble-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeFile(rel: string, contents: string): string {
  const p = join(workDir, rel);
  writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('parseHookInput', () => {
  it('returns null for non-JSON input', () => {
    expect(parseHookInput('not json')).toBeNull();
  });

  it('parses minimal valid input', () => {
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's',
        tool_name: 'Edit',
        tool_input: {},
      }),
    );
    expect(input).not.toBeNull();
  });
});

describe('assemble — Edit', () => {
  it('returns evaluate with file_after and pre-filtered rules on a domain file', () => {
    const fp = writeFile('Order.java', 'class Order { int x = 0; }\n');
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's-1',
        tool_name: 'Edit',
        tool_input: {
          file_path: fp,
          old_string: 'int x = 0;',
          new_string: 'int x = 1;',
        },
      }),
    )!;

    const out = assemble(input, {
      hookKind: 'pre',
      rules: [moneyRule],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });

    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.tool).toBe('Edit');
      expect(out.request.session_id).toBe('s-1');
      expect(out.request.file_after).toBe('class Order { int x = 1; }\n');
      // The fixture path is /tmp/.../Order.java which contains no '/domain/'
      // segment — money rule's path glob excludes it. Pre-filter drops it.
      expect(out.request.rule_set).toEqual([]);
    }
  });

  it('includes the rule when path matches the glob', () => {
    const dir = join(workDir, 'src', 'main', 'java', 'domain');
    mkdirSync(dir, { recursive: true });
    const fp = writeFile('src/main/java/domain/Order.java', 'class Order {}\n');

    const input = parseHookInput(
      JSON.stringify({
        session_id: 's-2',
        tool_name: 'Edit',
        tool_input: {
          file_path: fp,
          old_string: 'class Order {}',
          new_string: 'class Order { int x = 0; }',
        },
      }),
    )!;

    const out = assemble(input, {
      hookKind: 'pre',
      rules: [moneyRule, printlnRule],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });

    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.rule_set).toEqual(['AXT-JAVA-042']);
    }
  });

  it('skips when old_string is ambiguous', () => {
    const fp = writeFile('Ambig.java', 'int x = 0;\nint x = 0;\n');
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's',
        tool_name: 'Edit',
        tool_input: { file_path: fp, old_string: 'int x = 0;', new_string: 'int x = 1;' },
      }),
    )!;
    const out = assemble(input, {
      hookKind: 'pre',
      rules: [moneyRule],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('skip');
  });

  it('returns invalid when tool_input is malformed', () => {
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's',
        tool_name: 'Edit',
        tool_input: { file_path: 'x' /* missing old/new */ },
      }),
    )!;
    const out = assemble(input, {
      hookKind: 'pre',
      rules: [moneyRule],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('invalid');
  });
});

describe('assemble — Write', () => {
  it('returns evaluate for a new file', () => {
    const fp = join(workDir, 'NewFile.java');
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's',
        tool_name: 'Write',
        tool_input: { file_path: fp, content: 'class N {}\n' },
      }),
    )!;
    const out = assemble(input, {
      hookKind: 'pre',
      rules: [printlnRule],
      severities: new Set(['warning', 'suggestion']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.tool).toBe('Write');
      expect(out.request.file_after).toBe('class N {}\n');
      expect(out.request.rule_set).toEqual(['AXT-JAVA-077']);
    }
  });
});

describe('assemble — Bash and other tools', () => {
  it('skips Bash', () => {
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
    )!;
    const out = assemble(input, {
      hookKind: 'pre',
      rules: [moneyRule],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('skip');
  });
});

describe('assemble — CLAUDE_PROJECT_DIR resolution (D-024)', () => {
  it('resolves a relative file_path against the projectDir', () => {
    const fp = writeFile('Rel.java', 'class R { int x = 0; }\n');
    const relName = fp.slice(workDir.length + 1);
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's',
        tool_name: 'Edit',
        tool_input: {
          file_path: relName,
          old_string: 'int x = 0;',
          new_string: 'int x = 1;',
        },
      }),
    )!;
    const out = assemble(input, {
      hookKind: 'pre',
      rules: [moneyRule],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.file_path).toBe(fp);
      expect(out.request.file_after).toBe('class R { int x = 1; }\n');
    }
  });
});

describe('hook-kind wrappers — assembleForPre / assembleForPost (single engine, D-049)', () => {
  // Single-engine product: every rule is `llm`. The Pre/Post difference is now
  // (1) gate_check (server-side detection deferral) and (2) the Pre-only
  // high-altitude gate carve-out. There is no engine partition.
  const implBlocking: RuleSummary = {
    id: 'AXT-IMP-001',
    name: 'impl blocking',
    altitude: 'implementation',
    severity: 'blocking',
    language: 'java',
    paths: [],
  };
  const designWarning: RuleSummary = {
    id: 'AXT-DSG-001',
    name: 'design warning',
    altitude: 'design',
    severity: 'warning',
    language: 'java',
    paths: [],
  };
  const archWarning: RuleSummary = {
    id: 'AXT-ARC-001',
    name: 'arch warning',
    altitude: 'architectural',
    severity: 'warning',
    language: 'java',
    paths: [],
  };

  function _editPayload(filePath: string): string {
    return JSON.stringify({
      session_id: 's',
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: 'int x = 0;',
        new_string: 'int x = 1;',
      },
    });
  }

  // `designWarning` and `archWarning` are BOTH high-altitude. On the Pre path
  // they trigger the Mentor gate, so they must reach /evaluate even under the
  // real Pre severity set {blocking} (both are `warning`) via the carve-out.
  // `implBlocking` reaches it on severity. Detection is deferred server-side
  // (gate_check=true).
  it('assembleForPre keeps high-altitude rules regardless of severity and sets gate_check', () => {
    const fp = writeFile('PreGate.java', 'class Pre { int x = 0; }\n');
    const input = parseHookInput(_editPayload(fp))!;
    const out = assembleForPre(input, {
      rules: [implBlocking, designWarning, archWarning],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect([...out.request.rule_set].sort()).toEqual([
        'AXT-ARC-001',
        'AXT-DSG-001',
        'AXT-IMP-001',
      ]);
      expect(out.request.gate_check).toBe(true);
    }
  });

  it('assembleForPre still drops LOW-altitude rules below the severity threshold (carve-out is altitude-scoped)', () => {
    const lowAltWarning: RuleSummary = {
      id: 'AXT-IMP-LLM',
      name: 'impl warning',
      altitude: 'implementation',
      severity: 'warning',
      language: 'java',
      paths: [],
    };
    const fp = writeFile('PreLow.java', 'class Pre { int x = 0; }\n');
    const input = parseHookInput(_editPayload(fp))!;
    const out = assembleForPre(input, {
      rules: [lowAltWarning],
      severities: new Set(['blocking']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.rule_set).toEqual([]);
    }
  });

  // D-049 behavioral consequence: with no engine partition, Post forwards EVERY
  // severity-matched rule (all are `llm`), not an engine-filtered subset.
  it('assembleForPost forwards all severity-matched rules and sets gate_check=false', () => {
    const fp = writeFile('Post.java', 'class Post { int x = 0; }\n');
    const input = parseHookInput(_editPayload(fp))!;
    const out = assembleForPost(input, {
      rules: [implBlocking, designWarning, archWarning],
      severities: new Set(['blocking', 'warning', 'suggestion']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect([...out.request.rule_set].sort()).toEqual([
        'AXT-ARC-001',
        'AXT-DSG-001',
        'AXT-IMP-001',
      ]);
      // Post runs full LLM detection — it is NOT a gate-check call.
      expect(out.request.gate_check).toBe(false);
    }
  });

  it('a high-altitude rule reaches BOTH Pre (gate) and Post (detection)', () => {
    // archWarning is `architectural` (high-altitude). Pre sees it via the gate
    // carve-out (consult_required); Post sees it on severity (LLM detection).
    // No engine exclusion remains, so it is present on both paths.
    const fp = writeFile('Both.java', 'class H { int x = 0; }\n');
    const input = parseHookInput(_editPayload(fp))!;
    const pre = assembleForPre(input, {
      rules: [archWarning],
      severities: new Set(['blocking', 'warning', 'suggestion']),
      projectDir: workDir,
    });
    const post = assembleForPost(input, {
      rules: [archWarning],
      severities: new Set(['blocking', 'warning', 'suggestion']),
      projectDir: workDir,
    });
    expect(pre.kind).toBe('evaluate');
    expect(post.kind).toBe('evaluate');
    if (pre.kind === 'evaluate') expect(pre.request.rule_set).toEqual(['AXT-ARC-001']);
    if (post.kind === 'evaluate') expect(post.request.rule_set).toEqual(['AXT-ARC-001']);
  });
});

describe('PostToolUse observes file_after from disk (Step 10.7 fix)', () => {
  // Step 10.7 fix: Pre simulates the edit in memory via `applyEdit`; Post
  // reads `file_after` directly from disk because the edit has already
  // landed. These tests pin the Post-side semantics that the shared-with-Pre
  // path got wrong — rehearsal-#1 retry surfaced every PostToolUse Edit
  // skipping with `Edit pre-conditions: old_string_not_found` because the
  // on-disk file no longer contained `old_string`.
  const llmRule: RuleSummary = {
    id: 'AXT-LLM-007',
    name: 'refund cap',
    altitude: 'design',
    severity: 'warning',
    language: 'java',
    paths: [],
  };

  it('Edit on Post reads file_after from disk even when old_string is stale (post-edit file)', () => {
    // Real PostToolUse condition: by the time the hook fires, the file
    // on disk already contains `new_string` (the edit has landed). The
    // payload's `old_string` references the pre-edit content and is no
    // longer in the file. Pre simulator would skip with
    // `old_string_not_found`; Post must observe what's on disk.
    const fp = writeFile('OnDiskAfterEdit.java', 'int x = 1; // already edited\n');
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's-post',
        tool_name: 'Edit',
        tool_input: {
          file_path: fp,
          old_string: 'int x = 0;', // not in the on-disk file anymore
          new_string: 'int x = 1;',
        },
      }),
    )!;
    const out = assembleForPost(input, {
      rules: [llmRule],
      severities: new Set(['warning']),
      projectDir: workDir,
    });

    expect(out.kind).toBe('evaluate');
    if (out.kind === 'evaluate') {
      expect(out.request.tool).toBe('Edit');
      expect(out.request.file_after).toBe('int x = 1; // already edited\n');
      expect(out.request.diff).toBe('');
      expect(out.request.rule_set).toEqual(['AXT-LLM-007']);
    }
  });

  it('Edit on Post skips when the file does not exist on disk', () => {
    // Vanishingly rare: file deleted between the Edit landing and the
    // PostToolUse hook firing. Skip cleanly with a hook-named reason so
    // the trace log makes the architectural side immediately clear.
    const fp = join(workDir, 'NeverExisted.java');
    const input = parseHookInput(
      JSON.stringify({
        session_id: 's-post-missing',
        tool_name: 'Edit',
        tool_input: {
          file_path: fp,
          old_string: 'x',
          new_string: 'y',
        },
      }),
    )!;
    const out = assembleForPost(input, {
      rules: [llmRule],
      severities: new Set(['warning']),
      projectDir: workDir,
    });
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toBe('PostToolUse: file not found on disk');
    }
  });
});

describe('assemble — Bash + MCP-write dispatch (D-041 widening / D-042 deferral)', () => {
  it('Bash tool: returns skip with reason naming D-041 widening + D-042 deferral', () => {
    const out = assembleForPre(
      { tool_name: 'Bash', tool_input: { command: 'echo hi > out.txt' }, session_id: 's' },
      {
        rules: [moneyRule],
        severities: new Set(['blocking']),
        projectDir: '/tmp',
      },
    );
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toMatch(/D-041 widening/);
      expect(out.reason).toMatch(/D-042-placeholder/);
    }
  });

  it('MCP filesystem write tool: returns skip with the same D-042 reason', () => {
    const out = assembleForPre(
      {
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { path: '/tmp/x', contents: 'hi' },
        session_id: 's',
      },
      {
        rules: [moneyRule],
        severities: new Set(['blocking']),
        projectDir: '/tmp',
      },
    );
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.reason).toMatch(/D-041 widening/);
      expect(out.reason).toMatch(/D-042-placeholder/);
    }
  });
});
