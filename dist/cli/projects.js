#!/usr/bin/env node
/**
 * `axtar-projects` — bind this repository to one of the org's projects.
 *
 * A project owns a *pool* of rules; binding a repo to a project is what scopes
 * evaluation to exactly those rules. The binding lives entirely in the repo's
 * `.axtar/config.json` (commit it) — the platform keeps no per-repo record.
 *
 * Subcommands:
 *   list [--json]   — print the projects available to your API key
 *   select <ref>    — bind this repo to a project (by id or name) and persist
 *                     the choice in `.axtar/config.json`
 *   status          — show the current binding for this repo
 *   doctor          — check that the platform is reachable + the API key works
 *
 * This is the operator/agent-facing surface behind the `/axtar:projects`,
 * `/axtar:status`, and `/axtar:setup` Claude Code commands. It is NOT on the
 * hook hot path, so unlike the hooks it exits non-zero and prints actionable
 * errors on failure.
 *
 * Connection is configured exactly like the hooks: `AXTAR_ENGINE_URL` +
 * `AXTAR_API_KEY` (see shared/engine/config.ts).
 */
import { createEngineClient, } from '../shared/engine/client.js';
import { loadEngineConfig } from '../shared/engine/config.js';
import { configPath, readConfig, resolveProjectDir, saveProjectSelection, } from '../shared/project/config.js';
function out(line = '') {
    process.stdout.write(line + '\n');
}
function err(line) {
    process.stderr.write(line + '\n');
}
function explainFailure(result) {
    if (result.reason === 'http' && result.detail.startsWith('401')) {
        return 'Unauthorized (401). Set AXTAR_API_KEY to a valid axtar_pk_… token from the platform (Settings → API keys).';
    }
    if (result.reason === 'timeout' || result.reason === 'network') {
        return `Could not reach the platform at AXTAR_ENGINE_URL (${result.reason}: ${result.detail}). Is the URL correct and the service up?`;
    }
    return `Platform request failed (${result.reason}: ${result.detail}).`;
}
async function fetchProjects(client) {
    const result = await client.listProjects();
    if (!result.ok) {
        throw new Error(explainFailure(result));
    }
    return result.value;
}
function renderTable(projects) {
    if (projects.length === 0) {
        out('No projects found for this organization. Create one in the Axtar platform first.');
        return;
    }
    const header = `${'NAME'.padEnd(28)} ${'RULES'.padStart(5)}  ${'REPO'.padEnd(28)}  ID`;
    out(header);
    out('-'.repeat(header.length));
    for (const p of projects) {
        const repo = p.repo_full_name ?? '—';
        out(`${p.name.padEnd(28)} ${String(p.rule_count).padStart(5)}  ${repo.padEnd(28)}  ${p.id}`);
    }
}
/**
 * Resolve a user-typed ref to a project: an exact id match wins; otherwise a
 * case-insensitive name match. A name shared by several projects is ambiguous
 * — the caller is told to disambiguate by id.
 */
function resolveRef(projects, ref) {
    const lower = ref.toLowerCase();
    const byId = projects.find((p) => p.id.toLowerCase() === lower);
    if (byId) {
        return { project: byId };
    }
    const byName = projects.filter((p) => p.name.toLowerCase() === lower);
    if (byName.length === 1) {
        return { project: byName[0] };
    }
    if (byName.length > 1) {
        return {
            error: `"${ref}" matches ${byName.length} projects by name. Re-run with the project id instead.`,
        };
    }
    return { error: `No project matches "${ref}". Run \`axtar-projects list\` to see the options.` };
}
async function cmdList(client, json) {
    const projects = await fetchProjects(client);
    if (json) {
        out(JSON.stringify(projects, null, 2));
    }
    else {
        renderTable(projects);
    }
    return 0;
}
async function cmdSelect(client, ref) {
    if (!ref) {
        err('usage: axtar-projects select <id-or-name>');
        return 2;
    }
    const projectDir = resolveProjectDir();
    const projects = await fetchProjects(client);
    const resolved = resolveRef(projects, ref);
    if ('error' in resolved) {
        err(resolved.error);
        return 1;
    }
    const chosen = resolved.project;
    saveProjectSelection(projectDir, { id: chosen.id, name: chosen.name }, new Date().toISOString());
    out(`Bound this repo to project "${chosen.name}".`);
    out(`  project id:   ${chosen.id}`);
    out(`  rules:        ${chosen.rule_count} in this project's pool`);
    out(`  persisted to: ${configPath(projectDir)}  (commit this file)`);
    return 0;
}
function cmdStatus() {
    const projectDir = resolveProjectDir();
    const config = readConfig(projectDir);
    if (!config || !config.project) {
        out('No project bound to this repo yet.');
        out('  run `axtar-projects select <id-or-name>` to bind one.');
        return 0;
    }
    out(`project:    ${config.project.name}`);
    out(`project id: ${config.project.id}`);
    if (config.updatedAt) {
        out(`selected at: ${config.updatedAt}`);
    }
    return 0;
}
async function cmdDoctor(client) {
    const config = loadEngineConfig();
    out(`engine url: ${config.baseUrl}`);
    out(`api key:    ${config.apiKey ? 'set' : 'NOT set'}`);
    const result = await client.listProjects();
    if (!result.ok) {
        err(`platform check failed: ${explainFailure(result)}`);
        return 1;
    }
    out(`reachable and authorized — ${result.value.length} project(s) available.`);
    return 0;
}
async function main(argv) {
    const [command, ...rest] = argv;
    const client = createEngineClient(loadEngineConfig());
    switch (command) {
        case 'list':
            return cmdList(client, rest.includes('--json'));
        case 'select':
            return cmdSelect(client, rest.find((a) => !a.startsWith('-')));
        case 'status':
            return cmdStatus();
        case 'doctor':
            return cmdDoctor(client);
        case undefined:
        case '-h':
        case '--help':
            out('usage: axtar-projects <list [--json] | select <id-or-name> | status | doctor>');
            return command === undefined ? 2 : 0;
        default:
            err(`unknown command: ${command}`);
            err('usage: axtar-projects <list [--json] | select <id-or-name> | status | doctor>');
            return 2;
    }
}
main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
//# sourceMappingURL=projects.js.map