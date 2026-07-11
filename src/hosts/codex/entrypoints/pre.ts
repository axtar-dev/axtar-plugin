/**
 * Codex PreToolUse entrypoint — parallel to the Claude Code entrypoint.
 *
 * 11.5.3 state: compiles, wires every injection slot the shared runner
 * needs (parseInput, assemble, outputAdapter), but the adapter and
 * assemble are SHELLS — invoking this entrypoint will throw at the first
 * call into either. End-to-end firing waits on 11.5.4.
 *
 * Diagnostic trace (`AXTAR_HOOK_TRACE="true"`) is opt-in; same shape
 * as the Claude Code entrypoint via the shared `traceRaw` helper.
 */

import { codexOutputAdapter } from '../adapter.js';
import { assembleForPre } from '../assemble.js';
import { parseHookInput } from '../hook-input.js';
import { traceRaw } from '../../../shared/log.js';
import { readStdin, run } from '../../../shared/runner.js';
import type { Severity } from '../../../shared/wire/schemas.js';

traceRaw(
  `codex pre-tool-use fired at ${new Date().toISOString()} pid=${process.pid} CLAUDE_PLUGIN_ROOT=${process.env.CLAUDE_PLUGIN_ROOT ?? '<unset>'}\n`,
);

const PRE_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['blocking']);

async function main(): Promise<void> {
  const raw = await readStdin();
  await run(raw, {
    hook: 'PreToolUse',
    severities: PRE_SEVERITIES,
    parseInput: parseHookInput,
    assemble: assembleForPre,
    outputAdapter: codexOutputAdapter,
    consultLoopAvailable: false,
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack.replace(/\n/g, ' | ') : '';
  traceRaw(
    `[${new Date().toISOString()}] hook.crash hook="PreToolUse" host="codex" message=${JSON.stringify(message)} stack=${JSON.stringify(stack)}\n`,
  );
  process.stderr.write(`axtar: codex PreToolUse hook crashed: ${message}; allowing through.\n`);
  process.exit(0);
});
