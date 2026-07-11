/**
 * Codex hook-input parse + map to shared HookInput shape.
 *
 * Verifies the codex parser:
 *   - accepts the documented codex stdin envelope (CX-1 findings §1)
 *   - maps to the shared HookInput shape (`tool_name`, `tool_input`,
 *     `session_id`, `cwd`) without losing host-extras
 *   - returns null on invalid input
 *   - is lenient about unknown extra fields via `.passthrough()`
 *
 * Codex provides `session_id` directly (same field name as Claude Code),
 * so the mapping is identity on every shared-shape field.
 */

import { describe, expect, it } from 'vitest';

import { parseHookInput } from '../../src/hosts/codex/hook-input.js';

describe('codex parseHookInput', () => {
  it('parses a PreToolUse payload with apply_patch into shared HookInput', () => {
    const raw = JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/tmp/codex/session-abc.jsonl',
      cwd: '/home/dev/project',
      hook_event_name: 'PreToolUse',
      model: 'gpt-5',
      permission_mode: 'default',
      turn_id: 'turn-1',
      tool_name: 'apply_patch',
      tool_use_id: 'call-xyz',
      tool_input: {
        patch: '*** Begin Patch\n--- foo.ts\n+++ foo.ts\n@@ -1 +1 @@\n-a\n+b\n*** End Patch\n',
      },
    });
    const input = parseHookInput(raw);
    expect(input).not.toBeNull();
    expect(input?.tool_name).toBe('apply_patch');
    expect(input?.session_id).toBe('sess-abc');
    expect(input?.cwd).toBe('/home/dev/project');
    expect(input?.tool_input).toMatchObject({
      patch: expect.stringContaining('foo.ts'),
    });
  });

  it('parses a PostToolUse payload with tool_response', () => {
    const raw = JSON.stringify({
      session_id: 'sess-abc',
      cwd: '/home/dev/project',
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-1',
      tool_name: 'apply_patch',
      tool_use_id: 'call-xyz',
      tool_input: { patch: '*** Begin Patch\n...\n*** End Patch\n' },
      tool_response: { status: 'ok', files_changed: ['foo.ts'] },
    });
    const input = parseHookInput(raw);
    expect(input).not.toBeNull();
    expect(input?.tool_name).toBe('apply_patch');
    expect(input?.session_id).toBe('sess-abc');
  });

  it('returns null on non-JSON input', () => {
    expect(parseHookInput('this is not json')).toBeNull();
  });

  it('returns null on JSON missing required fields', () => {
    const raw = JSON.stringify({ tool_name: 'apply_patch' }); // missing session_id, tool_input
    expect(parseHookInput(raw)).toBeNull();
  });

  it('omits cwd when codex does not provide it', () => {
    const raw = JSON.stringify({
      session_id: 'sess-abc',
      tool_name: 'apply_patch',
      tool_input: {},
    });
    const input = parseHookInput(raw);
    expect(input).not.toBeNull();
    expect(input?.cwd).toBeUndefined();
  });

  it('passes through unknown extra fields without rejecting the payload', () => {
    const raw = JSON.stringify({
      session_id: 'sess-abc',
      tool_name: 'apply_patch',
      tool_input: {},
      future_codex_field: 'whatever',
    });
    const input = parseHookInput(raw);
    expect(input).not.toBeNull();
    expect(input?.tool_name).toBe('apply_patch');
  });
});
