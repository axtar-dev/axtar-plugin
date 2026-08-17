/**
 * The Axtar checks MCP server — the plugin's only runtime surface (spec §15).
 *
 * Four tools: the three calls of §9, plus the one read that makes them
 * bindable.
 *
 * - **`axtar_check_diff`** — the finished change. The agent passes no diff and
 *   no file contents: this server is the local *packet producer*
 *   (`shared/producer.ts`). It resolves `base_ref`, runs `git diff` against the
 *   working tree, reads the changed and untracked files whole, and uploads once.
 * - **`axtar_check_scan`** — existing code, as it stands. Same producer, no
 *   base ref: the agent names the files or globs, the server expands them
 *   against the work tree (tracked plus untracked-but-not-ignored) and ships
 *   them whole. It is the audit you reach for when there is no diff to judge.
 * - **`axtar_check_spec`** — the plan, before any code exists. Exactly one of
 *   `spec` or `spec_path`; a path is **read here**, so an agent never pastes a
 *   file it already has on disk into a tool call.
 * - **`axtar_projects`** — which projects exist, which one governs this repo,
 *   and the `.axtar/config.yml` to write to change that. It needs the env vars
 *   but **not** a binding: an unbound repo is precisely where it is asked. It
 *   is a *read*, never a selection — the platform stores no per-repo choice,
 *   and this server writes no file; §6's committed config is the only binding
 *   mechanism, so "switching project" is always an edit somebody commits.
 *
 * All four call the platform's `/mentor` sub-app with `AXTAR_API_KEY`; the three
 * checks post against the project named by `.axtar/config.yml` at the repo root.
 * Unconfigured or unbound, they **refuse with setup instructions** rather than
 * check against nothing — and the refusal says, in as many words, that it is not
 * a verdict.
 *
 * **This surface fails open** (§12). Engine down, timeout, 500, a body the wire
 * schemas cannot parse — every one comes back as text saying no verdict exists
 * and work may proceed. Nothing here throws an MCP error, and nothing here
 * invents a verdict; CI is the surface that fails closed.
 *
 * **stdout is the JSON-RPC channel — never write to it.** Diagnostics go to
 * stderr through `shared/log.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createEngineClient } from '../shared/engine/client.js';
import { ENGINE_URL_ENV, loadEngineConfig, setupInstructions } from '../shared/engine/config.js';
import { log } from '../shared/log.js';
import { findRepoRoot, produceScanPacket, producePacket } from '../shared/producer.js';
import { bindingInstructions, loadRepoBinding } from '../shared/project/config.js';
import { renderDiffResponse, renderFailOpen, renderProjects, renderProjectsFailure, renderRefusal, renderScanResponse, renderSchemaDrift, renderSpecResponse, } from '../shared/render.js';
import { DIFF_CHECK_PATH, DiffCheckRequestSchema, PROJECTS_PATH, SCAN_CHECK_PATH, SPEC_CHECK_PATH, ScanCheckRequestSchema, SpecCheckRequestSchema, parseDiffCheckResponse, parseProjectListResponse, parseScanCheckResponse, parseSpecCheckResponse, } from '../shared/wire/checks.js';
export const SERVER_NAME = 'axtar';
export const SERVER_VERSION = '0.1.0';
// --- the tool arguments ------------------------------------------------------
/**
 * The shapes double as the tools' published JSON Schema and as the guard the
 * handlers parse with, so an argument that reaches a handler has been through
 * zod whatever the host validated.
 */
export const CheckDiffArgsShape = {
    base_ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional. The ref the change is measured against. Default: the merge-base of HEAD with ' +
        'the default branch (origin/HEAD, else origin/main, else main).'),
    spec_path: z
        .string()
        .min(1)
        .optional()
        .describe('Optional. Path to the spec this change implements; the server reads it. Do not paste ' +
        'file contents.'),
    ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional. The thread this check belongs to (branch, PR number, spec id). Default: the ' +
        'current branch name.'),
};
export const CheckDiffArgsSchema = z.object(CheckDiffArgsShape).strict();
/**
 * `paths` is required and schema-enforced — an audit has to be *of* something.
 *
 * There is no "scan everything" default: the whole repo is not a review unit,
 * it is a bill, and a caller who meant one feature area would get a packet the
 * platform has to cap. `ref` has no default either (see the tool description).
 */
export const CheckScanArgsShape = {
    paths: z
        .array(z.string().min(1))
        .min(1)
        .describe('Required. The files or globs to audit, relative to the repo root — for example ' +
        '["src/billing/**", "docs/refunds.md"]. The server expands them against the working ' +
        'tree; do not paste file contents. Name a feature area, not the whole repo.'),
    ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional, and there is no default. Pass one only to thread repeated scans of the same ' +
        'area together (a ticket id, an area name) — an audit is not a change, so it belongs to ' +
        'no branch.'),
};
export const CheckScanArgsSchema = z.object(CheckScanArgsShape).strict();
export const CheckSpecArgsShape = {
    spec: z
        .string()
        .min(1)
        .optional()
        .describe('The spec text itself. Use this only for a plan that is not on disk.'),
    spec_path: z
        .string()
        .min(1)
        .optional()
        .describe('Path to the spec file; the server reads it from disk. Prefer this — do not paste the ' +
        'contents of a file you already have a path to.'),
    ref: z
        .string()
        .min(1)
        .optional()
        .describe('Optional. The thread this check belongs to (branch, PR number, spec id).'),
};
/**
 * Exactly one of `spec` / `spec_path` — enforced by the schema, not by a
 * hand-rolled `if`, so the message is the same wherever the arguments come from.
 */
export const CheckSpecArgsSchema = z
    .object(CheckSpecArgsShape)
    .strict()
    .superRefine((args, ctx) => {
    const given = [args.spec, args.spec_path].filter((value) => value !== undefined && value.trim().length > 0).length;
    if (given !== 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'pass exactly one of `spec` or `spec_path` — `spec_path` for a spec on disk (the ' +
                'server reads it), `spec` only for text that has no file.',
        });
    }
});
/**
 * `axtar_projects` takes nothing.
 *
 * The shape is empty and the schema is `.strict()` on purpose: there is no
 * `project` argument to pass, because listing is not selecting. An agent that
 * invents one gets told so instead of having it silently dropped and reading
 * the answer as a selection that happened.
 */
export const ProjectsArgsShape = {};
export const ProjectsArgsSchema = z.object(ProjectsArgsShape).strict();
export function defaultDeps() {
    return {
        env: process.env,
        cwd: process.cwd(),
        createClient: createEngineClient,
        produce: producePacket,
        findRoot: findRepoRoot,
        produceScan: produceScanPacket,
        readSpecFile: (absolutePath) => readFileSync(absolutePath, 'utf-8'),
    };
}
function text(body) {
    return { content: [{ type: 'text', text: body }] };
}
/**
 * The repo binding and the engine connection, or one refusal naming everything
 * that is missing. Both are reported together: telling a developer about the
 * env vars, and only then about the config, is two round trips for one setup.
 */
function resolveSetup(deps) {
    const binding = loadRepoBinding(deps.cwd);
    const engine = loadEngineConfig(deps.env);
    const problems = [];
    if (!binding.ok) {
        problems.push(bindingInstructions(binding));
        problems.push('Call axtar_projects (or run /axtar:projects) to see which projects exist and get the ' +
            'exact .axtar/config.yml to commit.');
    }
    if (!engine.ok)
        problems.push(setupInstructions(engine.missing));
    if (!binding.ok || !engine.ok) {
        return {
            ok: false,
            message: renderRefusal('Axtar is not set up for this repository', problems),
        };
    }
    log.debug('repo binding resolved', {
        project: binding.binding.projectId,
        config: binding.binding.configPath,
    });
    return {
        ok: true,
        setup: {
            projectId: binding.binding.projectId,
            configPath: binding.binding.configPath,
            client: deps.createClient(engine.config),
        },
    };
}
/**
 * The engine connection alone — no binding required.
 *
 * `axtar_projects` is the tool you reach for *because* the repo is unbound, so
 * demanding a binding first would make it useless exactly where it is needed.
 * Its only hard requirement is the two env vars.
 */
function resolveConnection(deps) {
    const engine = loadEngineConfig(deps.env);
    if (!engine.ok) {
        return {
            ok: false,
            message: renderRefusal('Axtar is not configured, so the project list could not be read', [
                setupInstructions(engine.missing),
            ]),
        };
    }
    return { ok: true, client: deps.createClient(engine.config) };
}
/** What an HTTP status from `/mentor` usually means, in the caller's terms. */
function failureHint(failure, projectId) {
    if (failure.reason !== 'http')
        return undefined;
    switch (failure.status) {
        case 401:
        case 403:
            return `AXTAR_API_KEY was rejected — check the key in the portal's Settings → API keys.`;
        case 404:
            return `project ${projectId} does not exist for this API key — check 'project:' in .axtar/config.yml.`;
        case 409:
            return 'the organization has no usable LLM provider configured — set one up in the portal.';
        case 422:
            return `the platform rejected the packet — 'project:' in .axtar/config.yml must be the project id the portal issued.`;
        default:
            return undefined;
    }
}
/**
 * The same statuses, read against `GET /projects` rather than a check.
 *
 * A 404 here is *not* a missing project — the route takes no id — so it almost
 * always means `AXTAR_ENGINE_URL` is missing its `/mentor` suffix, which is the
 * opposite advice `failureHint` gives.
 */
function projectsFailureHint(failure) {
    if (failure.reason !== 'http')
        return undefined;
    switch (failure.status) {
        case 401:
        case 403:
            return `AXTAR_API_KEY was rejected — check the key in the portal's Settings → API keys.`;
        case 404:
            return `${ENGINE_URL_ENV} is probably missing its /mentor suffix — GET /projects takes no id, so a 404 is the URL, not the project.`;
        default:
            return undefined;
    }
}
function failOpen(what, failure, projectId) {
    const reason = failure.reason === 'http'
        ? `HTTP ${failure.status} — ${failure.detail}`
        : `${failure.reason} — ${failure.detail}`;
    log.warn('check failed open', { what, reason });
    return text(renderFailOpen(what, reason, failureHint(failure, projectId)));
}
function argumentRefusal(tool, error) {
    return text(renderRefusal(`${tool} was called with arguments it cannot use`, error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
    })));
}
/** A spec named by path is read here — that is what the tool description promises. */
function readSpec(deps, specPath) {
    const absolute = resolve(deps.cwd, specPath);
    try {
        const spec = deps.readSpecFile(absolute);
        if (spec.trim().length === 0) {
            return { ok: false, message: renderRefusal('The spec file is empty', [absolute]) };
        }
        return { ok: true, spec };
    }
    catch (err) {
        return {
            ok: false,
            message: renderRefusal('The spec file could not be read', [
                `${absolute}: ${err instanceof Error ? err.message : String(err)}`,
            ]),
        };
    }
}
/** Why the packet could not be built — local, actionable, and not a verdict. */
function producerRefusal(what, failure) {
    const advice = {
        not_a_repo: 'Run the check from inside a git work tree.',
        no_commits: 'Make at least one commit, or pass base_ref explicitly.',
        unknown_base_ref: 'Fetch the ref first, or pass a base_ref this repo knows.',
        no_base_ref: 'Pass base_ref explicitly (for example the branch you will merge into).',
        no_files_matched: 'Name paths or globs that exist in this repo — a scan needs at least one file to audit. ' +
            'Ignored files (.gitignore) never match.',
        git_failed: 'Check that git works in this directory, then re-run.',
    };
    return text(renderRefusal(`Axtar could not assemble the ${what} packet`, [
        `${failure.reason}: ${failure.detail}`,
        advice[failure.reason] ?? 'Re-run once git is usable here.',
    ]));
}
/** The one line of producer provenance the agent gets, after the findings. */
function packetNote(packet) {
    const parts = [
        `${packet.files.length} file(s) sent whole`,
        `base ${packet.baseRef.slice(0, 12)} (${packet.baseRefLabel})`,
    ];
    if (packet.untracked.length > 0)
        parts.push(`${packet.untracked.length} untracked included`);
    if (packet.binarySkipped.length > 0) {
        parts.push(`${packet.binarySkipped.length} binary skipped (${packet.binarySkipped.join(', ')})`);
    }
    return `packet: ${parts.join(' · ')}`;
}
/** The same provenance line for an audit: what was asked for, what was sent. */
function scanPacketNote(packet) {
    const parts = [
        `${packet.files.length} file(s) sent whole`,
        `${packet.paths_requested.length} path(s) requested`,
    ];
    if (packet.skipped_binary.length > 0) {
        parts.push(`${packet.skipped_binary.length} binary skipped (${packet.skipped_binary.join(', ')})`);
    }
    return `packet: ${parts.join(' · ')}`;
}
// --- the tools ---------------------------------------------------------------
export async function runCheckDiff(rawArgs, deps) {
    const args = CheckDiffArgsSchema.safeParse(rawArgs ?? {});
    if (!args.success)
        return argumentRefusal('axtar_check_diff', args.error);
    const setup = resolveSetup(deps);
    if (!setup.ok)
        return text(setup.message);
    const produced = await deps.produce({ cwd: deps.cwd, baseRef: args.data.base_ref });
    if (!produced.ok)
        return producerRefusal('diff', produced);
    const packet = produced.value;
    let spec;
    if (args.data.spec_path !== undefined) {
        const read = readSpec(deps, args.data.spec_path);
        if (!read.ok)
            return text(read.message);
        spec = read.spec;
    }
    const ref = args.data.ref ?? packet.branch ?? undefined;
    const body = {
        project: setup.setup.projectId,
        diff: packet.diff,
        base_ref: packet.baseRef,
        files: packet.files,
        ...(spec === undefined ? {} : { spec }),
        ...(ref === undefined ? {} : { ref }),
    };
    // Our own packet, validated before it ships: the platform forbids unknown
    // fields, and a producer bug should name itself here rather than come back
    // as a 422 the agent has to decode.
    const request = DiffCheckRequestSchema.safeParse(body);
    if (!request.success)
        return argumentRefusal('the diff packet', request.error);
    log.info('posting diff check', {
        project: setup.setup.projectId,
        files: packet.files.length,
        base: packet.baseRef,
        ref: ref ?? null,
    });
    const result = await setup.setup.client.post(DIFF_CHECK_PATH, request.data, {
        parse: parseDiffCheckResponse,
    });
    if (!result.ok)
        return failOpen('diff', result, setup.setup.projectId);
    if (!result.value.ok) {
        log.warn('diff response failed the wire schema', { issues: result.value.issues });
        return text(`${renderSchemaDrift('diff', result.value)}\n\n${packetNote(packet)}`);
    }
    return text(`${renderDiffResponse(result.value.value)}\n\n${packetNote(packet)}`);
}
/**
 * `axtar_check_scan` — a conformance audit of the files as they are.
 *
 * Same refusals and the same fail-open direction as the diff check; the two
 * differences are both deliberate. The producer expands globs instead of
 * resolving a base ref, and **`ref` is passed through verbatim with no default**:
 * a diff belongs to the branch it is on, but an audit is not a change iterating,
 * so defaulting it to the branch name would thread this scan into a story nobody
 * wrote — "still outstanding since chk_7f2a91" about work that never happened.
 */
export async function runCheckScan(rawArgs, deps) {
    const args = CheckScanArgsSchema.safeParse(rawArgs ?? {});
    if (!args.success)
        return argumentRefusal('axtar_check_scan', args.error);
    const setup = resolveSetup(deps);
    if (!setup.ok)
        return text(setup.message);
    const root = await deps.findRoot(deps.cwd);
    if (!root.ok)
        return producerRefusal('scan', root);
    const produced = await deps.produceScan(root.value, args.data.paths);
    if (!produced.ok)
        return producerRefusal('scan', produced);
    const packet = produced.value;
    const body = {
        project: setup.setup.projectId,
        files: packet.files,
        paths_requested: packet.paths_requested,
        ...(args.data.ref === undefined ? {} : { ref: args.data.ref }),
    };
    const request = ScanCheckRequestSchema.safeParse(body);
    if (!request.success)
        return argumentRefusal('the scan packet', request.error);
    log.info('posting scan check', {
        project: setup.setup.projectId,
        files: packet.files.length,
        paths: packet.paths_requested.length,
        ref: args.data.ref ?? null,
    });
    const result = await setup.setup.client.post(SCAN_CHECK_PATH, request.data, {
        parse: parseScanCheckResponse,
    });
    if (!result.ok)
        return failOpen('scan', result, setup.setup.projectId);
    if (!result.value.ok) {
        log.warn('scan response failed the wire schema', { issues: result.value.issues });
        return text(`${renderSchemaDrift('scan', result.value)}\n\n${scanPacketNote(packet)}`);
    }
    return text(`${renderScanResponse(result.value.value)}\n\n${scanPacketNote(packet)}`);
}
export async function runCheckSpec(rawArgs, deps) {
    const args = CheckSpecArgsSchema.safeParse(rawArgs ?? {});
    if (!args.success)
        return argumentRefusal('axtar_check_spec', args.error);
    const setup = resolveSetup(deps);
    if (!setup.ok)
        return text(setup.message);
    let spec = args.data.spec;
    if (args.data.spec_path !== undefined) {
        const read = readSpec(deps, args.data.spec_path);
        if (!read.ok)
            return text(read.message);
        spec = read.spec;
    }
    if (spec === undefined) {
        // Unreachable through the schema; kept so a refactor cannot ship a request
        // with no artifact in it.
        return text(renderRefusal('axtar_check_spec received no spec', ['pass `spec` or `spec_path`']));
    }
    const body = {
        project: setup.setup.projectId,
        spec,
        ...(args.data.ref === undefined ? {} : { ref: args.data.ref }),
    };
    const request = SpecCheckRequestSchema.safeParse(body);
    if (!request.success)
        return argumentRefusal('the spec packet', request.error);
    log.info('posting spec check', {
        project: setup.setup.projectId,
        chars: spec.length,
        ref: args.data.ref ?? null,
    });
    const result = await setup.setup.client.post(SPEC_CHECK_PATH, request.data, {
        parse: parseSpecCheckResponse,
    });
    if (!result.ok)
        return failOpen('spec', result, setup.setup.projectId);
    if (!result.value.ok) {
        log.warn('spec response failed the wire schema', { issues: result.value.issues });
        return text(renderSchemaDrift('spec', result.value));
    }
    return text(renderSpecResponse(result.value.value));
}
/**
 * `axtar_projects` — what exists, what governs this repo, how to change it.
 *
 * Three things in one answer, because they are one question: the org's
 * projects, the id `.axtar/config.yml` currently names (or the fact that no
 * config exists here), and the file to write. Nothing is persisted anywhere —
 * the tool reads, the human or the agent commits.
 */
export async function runProjects(rawArgs, deps) {
    const args = ProjectsArgsSchema.safeParse(rawArgs ?? {});
    if (!args.success)
        return argumentRefusal('axtar_projects', args.error);
    const connection = resolveConnection(deps);
    if (!connection.ok)
        return text(connection.message);
    // The binding is read for context only: an unbound repo is a normal, expected
    // state here, not a refusal.
    const binding = loadRepoBinding(deps.cwd);
    const boundProjectId = binding.ok ? binding.binding.projectId : null;
    const configPath = binding.ok ? binding.binding.configPath : null;
    const unboundReason = binding.ok ? null : bindingInstructions(binding);
    log.info('listing projects', { bound: boundProjectId });
    const result = await connection.client.get(PROJECTS_PATH, {
        parse: parseProjectListResponse,
    });
    if (!result.ok) {
        const reason = result.reason === 'http'
            ? `HTTP ${result.status} — ${result.detail}`
            : `${result.reason} — ${result.detail}`;
        log.warn('projects listing failed open', { reason });
        return text(renderProjectsFailure(reason, boundProjectId, projectsFailureHint(result)));
    }
    if (!result.value.ok) {
        log.warn('projects response failed the wire schema', { issues: result.value.issues });
        return text(renderSchemaDrift('projects', result.value));
    }
    return text(renderProjects({
        projects: result.value.value,
        boundProjectId,
        configPath,
        unboundReason,
    }));
}
// --- registration ------------------------------------------------------------
export const CHECK_DIFF_DESCRIPTION = [
    "Check the change you just made against the rules this repo's Axtar project enforces, and get",
    'back the breaches, the advisories, and a receipt of what was considered.',
    '',
    'Call it when a change is done, before you summarise it or open a PR.',
    '',
    'Pass NO diff and NO file contents: this server reads the working tree itself (uncommitted and',
    'untracked work included) and uploads the packet. base_ref defaults to the merge-base with the',
    'default branch; ref defaults to the current branch.',
    '',
    'Surface the receipt block it returns (check_id, url, summary) verbatim in your summary to the',
    'developer and in any PR description you write — it is the evidence the change was checked',
    'against the whole rule corpus, and the url is the immutable record of it.',
].join('\n');
export const CHECK_SCAN_DESCRIPTION = [
    "Check EXISTING code against the project's rules — a conformance audit of the files as they",
    'are. Use axtar_check_diff for a change; use this when there is no diff. Scan a feature area',
    '(globs), not the whole repo.',
    '',
    'Pass paths (files or globs, relative to the repo root); the server expands them against the',
    'working tree and reads the files itself — pass NO file contents. Pass ref only to thread',
    'repeated scans of the same area together; it has no default, because an audit is not a change.',
    '',
    'Surface the receipt block it returns (check_id, url, summary) verbatim in your summary to the',
    'developer — it is the evidence these files were checked against the whole rule corpus, and the',
    'url is the immutable record of it.',
].join('\n');
export const CHECK_SPEC_DESCRIPTION = [
    'Check a plan BEFORE writing code: returns the constraints the spec should state, the passages',
    'a rule forbids, the rules it leaves unaddressed, and a receipt of what was considered.',
    '',
    'Call it as soon as a spec or plan exists — the corrections are free here and expensive later.',
    'Paste the must_state lines into the spec so whatever implements it carries the governance.',
    'Advisory, always: a spec check never blocks.',
    '',
    'Pass exactly one of spec or spec_path. For a spec on disk pass spec_path — the server reads',
    'the file; do not paste file contents you already have a path to.',
    '',
    'Surface the receipt block it returns (check_id, url, summary) verbatim in your summary to the',
    'developer — it is the evidence the plan was checked against the whole rule corpus.',
].join('\n');
export const PROJECTS_DESCRIPTION = [
    'List the Axtar projects this API key can see, say which one governs THIS repo, and give the',
    'exact .axtar/config.yml to write to bind or switch it.',
    '',
    'Call it for any binding question: "which Axtar project is this repo on", "what projects do we',
    'have", "switch this repo to another project", or after axtar_check_diff / axtar_check_spec',
    'refused because the repo is unbound. It needs no binding itself — an unbound repo is exactly',
    'where it is useful.',
    '',
    'It reads; it never selects. The committed .axtar/config.yml is the only binding mechanism and',
    'the platform stores no per-repo choice, so changing project means editing that file and',
    'committing it (push before running ingest). Take no argument — there is no project to pass.',
].join('\n');
/**
 * The last line of the fail-open guarantee (§12).
 *
 * The handlers below are written not to throw, and the engine client never
 * does — but "never throws" is a property that has to survive every future
 * edit, and a bug in this plugin must not surface to the agent as a failed tool
 * call it might retry or reason about. Anything unexpected becomes the same
 * text every other outage produces: no verdict, work may proceed.
 */
async function guarded(what, run) {
    try {
        return await run();
    }
    catch (err) {
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log.error('tool handler threw — failing open', { what, detail });
        if (what === 'projects') {
            return text(renderProjectsFailure(`the plugin hit an internal error (${detail})`, null, undefined));
        }
        return text(renderFailOpen(what, `the plugin hit an internal error (${detail})`));
    }
}
export function createServer(deps = defaultDeps()) {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    server.registerTool('axtar_check_diff', {
        title: 'Axtar: check this change',
        description: CHECK_DIFF_DESCRIPTION,
        inputSchema: CheckDiffArgsShape,
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, (args) => guarded('diff', () => runCheckDiff(args, deps)));
    server.registerTool('axtar_check_scan', {
        title: 'Axtar: audit existing code',
        description: CHECK_SCAN_DESCRIPTION,
        inputSchema: CheckScanArgsShape,
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, (args) => guarded('scan', () => runCheckScan(args, deps)));
    server.registerTool('axtar_check_spec', {
        title: 'Axtar: check this spec',
        description: CHECK_SPEC_DESCRIPTION,
        inputSchema: CheckSpecArgsShape,
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, (args) => guarded('spec', () => runCheckSpec(args, deps)));
    server.registerTool('axtar_projects', {
        title: 'Axtar: projects and this repo’s binding',
        description: PROJECTS_DESCRIPTION,
        inputSchema: ProjectsArgsShape,
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, (args) => guarded('projects', () => runProjects(args, deps)));
    return server;
}
export async function main() {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    log.info('axtar checks mcp server ready', { tools: 4 });
}
// Start only when run as the entrypoint (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('checks-server.js')) {
    main().catch((e) => {
        process.stderr.write(`axtar checks mcp crashed: ${String(e)}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=checks-server.js.map