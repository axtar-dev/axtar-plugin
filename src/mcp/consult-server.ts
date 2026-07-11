/**
 * Bundled stdio MCP `consult` server (Task H1).
 *
 * The PreToolUse Mentor gate, when it blocks a flagged high-altitude edit,
 * tells the agent to call this `consult` tool — passing the HOST-sourced
 * `session_id` the gate surfaced, the flagged file(s), and a
 * question/proposed_edit/plan. This server is the consult side of that
 * exchange.
 *
 * Trust model (governs the design — do not "improve" it):
 *   - `session_id` is RELAYED VERBATIM to `POST /mentor/consult`. The server
 *     does NOT validate, default, or invent it. The gate is the trust anchor;
 *     a mismatched session_id simply fails to clear the gate. A missing/empty
 *     session_id is rejected by the input schema, never silently filled.
 *   - `files[]` is the agent-declared scope, passed through UNFILTERED. The
 *     per-file substantiation (farming) defense lives server-side in
 *     `/mentor/consult`; this server must not pre-filter or second-guess it.
 *
 * stdout is the JSON-RPC channel: NEVER `console.log` here. Diagnostics go to
 * `process.stderr`. Engine failures never throw — they become text content.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createEngineClient } from '../shared/engine/client.js';
import { loadConsultConfig, type EngineConfig } from '../shared/engine/config.js';
import { resolveProjectDir, selectedProjectId } from '../shared/project/config.js';
import type { ConsultRequest } from '../shared/wire/schemas.js';

// Mirrors the engine ConsultRequest contract. session_id + files REQUIRED (no
// defaults). The optional fields stay optional; nothing here is invented.
export const CONSULT_INPUT_SHAPE = {
  session_id: z
    .string()
    .min(1)
    .describe(
      'The session_id from the Mentor block message — relay it verbatim; do not invent one.',
    ),
  files: z
    .array(z.string())
    .min(1)
    .describe(
      'The file(s) this consultation covers (the flagged file). The server passes these through; do not pre-filter.',
    ),
  question: z
    .string()
    .optional()
    .describe(
      'Free-form question, e.g. "which layer should this live in?" or "is there precedent for X?"',
    ),
  proposed_edit: z.string().optional(),
  plan: z.string().optional(),
  file_context: z.string().optional(),
};

type ConsultClient = Pick<ReturnType<typeof createEngineClient>, 'consult'>;

// Optional fields are `string | undefined` (not exact-optional) so the SDK's
// `ShapeOutput<typeof CONSULT_INPUT_SHAPE>` — which widens optionals to
// `| undefined` — is assignable here. The handler strips undefined before
// forwarding to the engine, so no `undefined` reaches the wire contract.
interface ConsultArgs {
  session_id: string;
  files: string[];
  question?: string | undefined;
  proposed_edit?: string | undefined;
  plan?: string | undefined;
  file_context?: string | undefined;
}

export async function handleConsult(
  client: ConsultClient,
  args: ConsultArgs,
  projectId?: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  // Relay VERBATIM — no validation of session_id, no defaulting, no filtering
  // of files. Build the request omitting absent optional fields so the engine
  // schema (`exactOptionalPropertyTypes`) sees no `undefined` values.
  const req: ConsultRequest = { session_id: args.session_id, files: args.files };
  if (args.question !== undefined) req.question = args.question;
  if (args.proposed_edit !== undefined) req.proposed_edit = args.proposed_edit;
  if (args.plan !== undefined) req.plan = args.plan;
  if (args.file_context !== undefined) req.file_context = args.file_context;
  // The bound project comes from the repo's `.axtar/config.json` (NOT an agent
  // arg — the agent doesn't choose which project governs), the same binding the
  // gate/evaluate use. Scopes the server-side trigger derivation to its pool.
  if (projectId !== undefined) req.project_id = projectId;

  const res = await client.consult(req);
  const text = res.ok
    ? JSON.stringify(res.value, null, 2)
    : `Mentor consultation failed (${res.reason}): ${res.detail ?? ''}. The Mentor gate will still block this edit until a successful consultation approves it.`;
  return { content: [{ type: 'text', text }] };
}

// session_summary tool (D-064): read-only fetch of the session summary, whose
// narrative_markdown already renders the "Judgment calls" section. Under Rung 2
// the agent calls this when concluding a resolution; the judgment-calls section
// goes in the resolution summary — the agent's closing message — which populates
// a PR description only if the human's workflow opens one downstream (the
// disclosure must never depend on a PR existing).
export const SESSION_SUMMARY_INPUT_SHAPE = {
  session_id: z
    .string()
    .min(1)
    .describe(
      'The session_id whose summary to fetch — the same id the Mentor block surfaced. Relay it verbatim.',
    ),
};

type SummaryClient = Pick<ReturnType<typeof createEngineClient>, 'summary'>;

export async function handleSessionSummary(
  client: SummaryClient,
  args: { session_id: string },
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const res = await client.summary(args.session_id);
  const text = res.ok
    ? JSON.stringify(res.value, null, 2)
    : `Session summary unavailable (${res.reason}): ${res.detail ?? ''}.`;
  return { content: [{ type: 'text', text }] };
}

/**
 * Engine config this server builds its client from. Distinct from the
 * gate/evaluate hooks: consultations are quality-first, so this uses the
 * consult timeout (`AXTAR_CONSULT_TIMEOUT_MS`, default 90 s) — NOT the 10 s
 * hook budget that gives up before the mentor + adversarial-guard LLM calls
 * return. Exported so the wiring is asserted directly in tests.
 */
export function consultEngineConfig(): EngineConfig {
  return loadConsultConfig();
}

export async function main(): Promise<void> {
  const client = createEngineClient(consultEngineConfig());
  const server = new McpServer({ name: 'axtar-mentor', version: '0.1.0' });

  server.registerTool(
    'consult',
    {
      title: 'Consult Axtar Mentor',
      description:
        'Consult Axtar Mentor before a high-altitude edit. When the Mentor gate blocks an edit, call this with the session_id from the block message, the flagged file(s), and your question / proposed_edit / plan. An "approve" verdict clears the gate so the edit can proceed; "revise"/"block" do not.',
      inputSchema: CONSULT_INPUT_SHAPE,
    },
    (args) => handleConsult(client, args, selectedProjectId(resolveProjectDir()) ?? undefined),
  );

  server.registerTool(
    'session_summary',
    {
      title: 'Axtar session summary',
      description:
        'Fetch the read-only Axtar session summary for the current session — including the "Judgment calls" section (decisions the rules permitted but did not dictate). Under Rung 2, call this when concluding a resolution and include the judgment-calls section in your resolution summary (your closing message); if the workflow opens a pull request downstream, that summary populates its description.',
      inputSchema: SESSION_SUMMARY_INPUT_SHAPE,
    },
    (args) => handleSessionSummary(client, args),
  );

  await server.connect(new StdioServerTransport());
}

// Start only when run as the entrypoint (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('consult-server.js')) {
  main().catch((e) => {
    process.stderr.write(`axtar-mentor mcp crashed: ${String(e)}\n`);
    process.exit(1);
  });
}
