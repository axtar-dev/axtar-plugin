/**
 * PostToolUse entrypoint — surfaces warning- and suggestion-severity rules
 * after the edit has landed. Always exits 0; we cannot un-do a committed
 * edit. Stderr is informational.
 *
 * Diagnostic trace (`AXTAR_HOOK_TRACE="true"`) is opt-in: top-of-module
 * marker (catches the "did the hook fire at all?" question before
 * `main()` even enters) and crash capture in the `.catch()` handler.
 * Both go through `traceRaw` which gates internally.
 */

import { claudeCodeOutputAdapter } from '../adapter.js';
import { assembleForPost, parseHookInput } from '../assemble.js';
import { traceRaw } from '../../../shared/log.js';
import { readStdin, run } from '../../../shared/runner.js';
import type { Severity } from '../../../shared/wire/schemas.js';

traceRaw(`[${new Date().toISOString()}] post-tool-use.fired pid=${process.pid}\n`);

const POST_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['warning', 'suggestion']);

async function main(): Promise<void> {
  const raw = await readStdin();
  await run(raw, {
    hook: 'PostToolUse',
    severities: POST_SEVERITIES,
    parseInput: parseHookInput,
    assemble: assembleForPost,
    outputAdapter: claudeCodeOutputAdapter,
    consultLoopAvailable: true,
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack.replace(/\n/g, ' | ') : '';
  traceRaw(
    `[${new Date().toISOString()}] hook.crash hook="PostToolUse" message=${JSON.stringify(message)} stack=${JSON.stringify(stack)}\n`,
  );
  process.stderr.write(`axtar: PostToolUse hook crashed: ${message}.\n`);
  process.exit(0);
});
