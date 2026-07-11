/**
 * PreToolUse entrypoint — gates blocking-severity rules. Exit code 2 with
 * structured plain-text stderr surfaces a block to Claude Code (D-022).
 *
 * Diagnostic trace (`AXTAR_HOOK_TRACE="true"`) is opt-in: top-of-module
 * marker (catches the "did the hook fire at all?" question before
 * `main()` even enters) and crash capture in the `.catch()` handler.
 * Both go through `traceRaw` which gates internally.
 */
import { claudeCodeOutputAdapter } from '../adapter.js';
import { assembleForPre, parseHookInput } from '../assemble.js';
import { traceRaw } from '../../../shared/log.js';
import { readStdin, run } from '../../../shared/runner.js';
traceRaw(`pre-tool-use fired at ${new Date().toISOString()} pid=${process.pid}\n`);
const PRE_SEVERITIES = new Set(['blocking']);
async function main() {
    const raw = await readStdin();
    await run(raw, {
        hook: 'PreToolUse',
        severities: PRE_SEVERITIES,
        parseInput: parseHookInput,
        assemble: assembleForPre,
        outputAdapter: claudeCodeOutputAdapter,
        consultLoopAvailable: true,
    });
}
main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack.replace(/\n/g, ' | ') : '';
    traceRaw(`[${new Date().toISOString()}] hook.crash hook="PreToolUse" message=${JSON.stringify(message)} stack=${JSON.stringify(stack)}\n`);
    process.stderr.write(`axtar: PreToolUse hook crashed: ${message}; allowing edit through.\n`);
    process.exit(0);
});
//# sourceMappingURL=pre.js.map