/**
 * Shared runner for PreToolUse and PostToolUse. Both hooks read the same
 * stdin, hit the same /evaluate endpoint, and differ only in:
 *   - which severities they care about (Pre = blocking; Post = warning + suggestion)
 *   - whether `block` exits 2 or 0 (Pre exits 2; Post always exits 0)
 *
 * The runner is host-agnostic. It consumes host-specific work through
 * three injected slots on `RunOptions`:
 *   - `parseInput`     — host's stdin → shared `HookInput` parser
 *   - `assemble`       — host's `AssembleFn` (parsed input → outcome)
 *   - `outputAdapter`  — host's `OutputAdapter` (verdict / unreachable
 *                        → `HookEmission` descriptor)
 *
 * Step 11.5.2 introduced these slots and removed the runner's direct
 * `import` of anything under `src/hosts/`. The shared/ → hosts/ seam
 * D-039 demands is now clean.
 *
 * Diagnostic trace (`AXTAR_HOOK_TRACE="true"`) is opt-in. The `trace`
 * helper lives in `./log.js`; `exitWithTrace` stays runner-local
 * because it wraps `process.exit` which is genuinely runner-specific.
 */

import { createEngineClient } from './engine/client.js';
import { loadEngineConfig } from './engine/config.js';
import { driftAdvisory } from './drift-advisory.js';
import { consultUnavailableAdvisory, decideGate } from './gate-step.js';
import { log, trace } from './log.js';
import type { OutputAdapter } from './output/adapter.js';
import type { AssembleFn, ParseInputFn } from './payload-types.js';
import { selectedProjectId } from './project/config.js';
import { isRung2, rung2Heartbeat } from './rung.js';
import { createRulesCache } from './rules/cache.js';
import type { Severity } from './wire/schemas.js';

export interface RunOptions {
  hook: 'PreToolUse' | 'PostToolUse';
  severities: ReadonlySet<Severity>;
  parseInput: ParseInputFn;
  assemble: AssembleFn;
  outputAdapter: OutputAdapter;
  // Whether THIS host has the bundled consult tool and can therefore enforce
  // the MANDATORY Mentor consult loop (hard block → consult → clear). Claude
  // Code bundles the consult MCP tool (`.mcp.json`) → true. A host that does
  // NOT bundle it → false, so an uncleared gate there must NOT hard-deny at a
  // tool that doesn't exist.
  consultLoopAvailable: boolean;
}

function emit(emission: { exitCode: number; stdout?: string; stderr?: string }): void {
  if (emission.stdout && emission.stdout.length > 0) {
    process.stdout.write(emission.stdout);
  }
  if (emission.stderr && emission.stderr.length > 0) {
    process.stderr.write(emission.stderr);
  }
}

function exitWithTrace(code: number, reason: string): never {
  trace('runner.exit', { code, reason });
  process.exit(code);
}

export async function run(stdinRaw: string, options: RunOptions): Promise<void> {
  trace('runner.enter', { hook: options.hook, pid: process.pid });

  const input = options.parseInput(stdinRaw);
  if (input === null) {
    trace('runner.stdin.parse.fail', { stdin_len: stdinRaw.length });
    log.warn('hook stdin was not valid JSON; allowing tool call through');
    exitWithTrace(0, 'stdin_invalid_json');
  }

  const filePathHint =
    typeof input.tool_input === 'object' && input.tool_input !== null
      ? ((input.tool_input as Record<string, unknown>).file_path as unknown)
      : undefined;
  trace('runner.stdin.parsed', {
    tool_name: input.tool_name,
    file_path: typeof filePathHint === 'string' ? filePathHint : null,
    session_id: input.session_id,
  });

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const config = loadEngineConfig();
  const client = createEngineClient(config);
  const cache = createRulesCache(client);

  // Scope evaluation to the repo's selected project's rule pool (the org
  // constitution is still merged server-side). Unbound repos send no scope and
  // see all rules.
  const projectId = selectedProjectId(projectDir) ?? undefined;
  trace('rules.fetch.start', {
    url: `${config.baseUrl}/rules`,
    timeout_ms: config.timeoutMs,
    project_id: projectId ?? null,
  });
  const rules = await cache.fetch(projectId);
  if (rules === null) {
    trace('rules.fetch.error', {
      detail: 'cache.fetch returned null (see rules.cache.* entries above)',
    });
    emit(options.outputAdapter.renderEngineUnreachable('GET /rules failed'));
    exitWithTrace(0, 'rules_fetch_failed');
  }
  trace('rules.fetch.ok', { count: rules.length });

  const outcome = options.assemble(input, {
    rules,
    severities: options.severities,
    projectDir,
  });

  if (outcome.kind === 'invalid') {
    trace('assemble.invalid', { detail: outcome.detail });
    log.warn('hook payload was malformed; allowing tool call through', {
      detail: outcome.detail,
    });
    exitWithTrace(0, 'assemble_invalid');
  }
  if (outcome.kind === 'skip') {
    trace('assemble.skip', { reason: outcome.reason });
    log.debug('skipping evaluation', { reason: outcome.reason });
    exitWithTrace(0, 'assemble_skip');
  }

  trace('prefilter.result', {
    loaded: rules.length,
    survived: outcome.request.rule_set.length,
    file_path: outcome.request.file_path,
    tool: outcome.request.tool,
  });

  if (outcome.request.rule_set.length === 0) {
    log.debug('no applicable rules after pre-filter; skipping engine call');
    exitWithTrace(0, 'prefilter_empty');
  }

  trace('evaluate.start', {
    url: `${config.baseUrl}/evaluate`,
    rule_count: outcome.request.rule_set.length,
    diff_bytes: outcome.request.diff.length,
  });
  // Carry the bound project so the server enforces exactly this project's pool
  // (omitted when unbound → org-wide scope, back-compat).
  const result = await client.evaluate(
    projectId ? { ...outcome.request, project_id: projectId } : outcome.request,
  );
  if (!result.ok) {
    trace('evaluate.error', { reason: result.reason, detail: result.detail });
    emit(options.outputAdapter.renderEngineUnreachable(`${result.reason}: ${result.detail}`));
    exitWithTrace(0, 'evaluate_failed');
  }
  trace('evaluate.ok', {
    verdict: result.value.verdict,
    violation_count: result.value.violations.length,
    consult_required: result.value.consult_required,
  });

  // Mentor gate branch (G1) — PreToolUse only. When the engine flags the edit
  // as needing consultation, consult the Mentor gate before allowing the
  // write. The gate decision is one of three observable outcomes:
  //   block  → exit 2, tell the agent to consult (the ONLY denial path);
  //   bypass → fail OPEN, allow the edit + loud advisory + best-effort audit;
  //   proceed → fall through to the normal verdict render below.
  // The two discriminants live in decideGate (pure): only ok+!cleared blocks;
  // ANY ok:false fails open. See gate-step.ts.
  if (options.hook === 'PreToolUse' && result.value.consult_required) {
    trace('mentor.gate.start', {
      url: `${config.baseUrl}/gate`,
      file_path: outcome.request.file_path,
      rule_count: outcome.request.rule_set.length,
    });
    const gateRes = await client.gate({
      session_id: input.session_id,
      file_path: outcome.request.file_path,
      rule_set: outcome.request.rule_set,
      ...(projectId ? { project_id: projectId } : {}),
    });
    trace('mentor.gate.result', {
      ok: gateRes.ok,
      cleared: gateRes.ok ? gateRes.value.cleared : null,
      reason: gateRes.ok ? null : gateRes.reason,
    });
    // Rung-2 (D-063): resolve the autonomy rung (best-effort, project-scoped) so the
    // block message can carry the standing authorization. Any failure → undefined → Rung 1.
    const policyRes = await client.policy(projectId);
    const rung = policyRes.ok ? policyRes.value.autonomy_rung : undefined;
    trace('mentor.policy.result', { ok: policyRes.ok, rung: rung ?? null });
    const decision = decideGate(
      result.value,
      gateRes,
      {
        session_id: input.session_id,
        file_path: outcome.request.file_path,
        rule_set: outcome.request.rule_set,
      },
      rung,
    );
    if (decision.kind === 'block') {
      if (options.consultLoopAvailable) {
        // Claude Code: the mandatory consult loop is available — hard block, agent must consult.
        emit(options.outputAdapter.renderMentorBlock(decision.message));
        exitWithTrace(2, 'mentor_gate_block');
      }
      // A host without the consult tool: the consult loop is v1-DEFERRED on
      // this host. A hard deny would point at a consult tool that does not exist here — a
      // dead-end. Structurally this is the same as gate-unreachable: we cannot complete the
      // loop, so we emit a GOVERNANCE ADVISORY and PROCEED (exit 0), never dead-end. The
      // mandatory consult loop for such a host lands in v2. (See spec v1/v2 boundary.)
      const advisory = consultUnavailableAdvisory(decision.triggered_rule_ids);
      emit(options.outputAdapter.renderMentorBypass(advisory));
      await client
        .bypass({
          session_id: input.session_id,
          file_path: outcome.request.file_path,
          triggered_rule_ids: decision.triggered_rule_ids,
          reason: 'consult_unavailable_on_host',
          ...(projectId ? { project_id: projectId } : {}),
        })
        .catch(() => {
          /* audit is best-effort; never gate the allow on it */
        });
      exitWithTrace(0, 'mentor_gate_advisory_no_consult');
    }
    if (decision.kind === 'bypass') {
      // FAIL-SOFT (non-negotiable): emit the advisory + allow the edit FIRST,
      // unconditionally. The audit POST is best-effort — its failure (even a
      // fully-down engine) must NOT change the allow decision or exit code.
      emit(options.outputAdapter.renderMentorBypass(decision.message));
      await client
        .bypass({
          session_id: input.session_id,
          file_path: outcome.request.file_path,
          triggered_rule_ids: decision.triggered_rule_ids,
          reason: 'gate_unreachable',
          ...(projectId ? { project_id: projectId } : {}),
        })
        .catch(() => {
          /* audit is best-effort; never gate the allow on it */
        });
      exitWithTrace(0, 'mentor_gate_bypass');
    }
    // proceed → fall through to the normal verdict render below.
  }

  // Build rule_id → name from the cache the hook already populated for
  // path pre-filtering (D-020). Lets the formatter render the boxed
  // rule line without duplicating `name` on the wire (D-029).
  const ruleNames = new Map(rules.map((r) => [r.id, r.name]));

  // v1 PostToolUse drift advisory (I1) — a RULE-SCOPED REMINDER, not a drift
  // verdict. After a high-altitude edit lands, remind the agent the file is
  // under Mentor governance so it verifies the change still matches what it
  // cleared in consult. `outcome.request.rule_set` is the rules the Post path
  // evaluated for this file; when empty, driftAdvisory returns null (no rules,
  // no reminder). The full landed-content-vs-consult substance comparison is
  // deferred to v2 (it needs the v2 server-threaded consultation transcript).
  const drift =
    options.hook === 'PostToolUse'
      ? driftAdvisory(result.value.consult_required, outcome.request.rule_set)
      : null;
  if (drift !== null) {
    // THE SKIP-LOG: be explicit that v1 does not do substance comparison.
    log.info(
      'mentor drift advisory (v1 rule-scoped reminder); substance-drift comparison deferred to v2',
      { file_path: outcome.request.file_path },
    );
  }
  // Rung-2 heartbeat (D-063 secondary): between blocks, re-anchor the autonomous
  // disposition. High-altitude post-edits only (mirrors the drift advisory's gate),
  // best-effort; any policy failure / non-rung2 → no heartbeat.
  let rungHeartbeat: string | undefined;
  if (options.hook === 'PostToolUse' && result.value.consult_required) {
    const policyRes = await client.policy(projectId);
    if (policyRes.ok && isRung2(policyRes.value.autonomy_rung)) {
      rungHeartbeat = rung2Heartbeat();
    }
  }
  const emission = options.outputAdapter.render(result.value, {
    hook: options.hook,
    ruleNames,
    ...(drift !== null ? { driftAdvisory: drift } : {}),
    ...(rungHeartbeat !== undefined ? { rungHeartbeat } : {}),
  });
  trace('verdict.rendered', {
    verdict: result.value.verdict,
    exit_code: emission.exitCode,
    stderr_bytes: emission.stderr?.length ?? 0,
    stdout_bytes: emission.stdout?.length ?? 0,
  });
  emit(emission);
  exitWithTrace(emission.exitCode, 'verdict_rendered');
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
