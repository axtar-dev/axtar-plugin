/**
 * Which project governs this repo — read from `.axtar/config.yml` at the repo
 * root (spec §6, §15).
 *
 * The committed config is **the only binding mechanism**: the portal generates
 * the file, the team commits it, and the binding travels with the repo. There
 * is no local selection state, no chooser, and nothing this plugin ever writes —
 * a repo without the file is a repo Axtar does not govern, and the tools refuse
 * with setup instructions rather than guessing.
 *
 * **Only `project:` is read here.** The rest of the file (`knowledge.docs`,
 * `knowledge.code`) is the ingest contract and is parsed, strictly, by the
 * platform — which is the side that acts on it. Duplicating that validation
 * locally would mean two validators disagreeing about the same file, and the
 * plugin would be the one nobody updates.
 *
 * Which is why the parse below is a **tolerant top-level scan**, not a YAML
 * implementation: it finds the one unindented `project:` key and takes its
 * scalar value. A config with a nested `project:` (inside `knowledge:`) is
 * indented and correctly ignored; a config the platform would reject for other
 * reasons still yields its project id here, and the platform says why it is bad.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
/** The config file's location relative to the repo root. */
export const CONFIG_RELATIVE_PATH = '.axtar/config.yml';
/**
 * Where to start looking. Claude Code exports `CLAUDE_PROJECT_DIR` for the
 * workspace root; outside it, the server's own working directory is the best
 * available answer.
 */
export function resolveRepoDir(env = process.env) {
    const fromEnv = env.CLAUDE_PROJECT_DIR?.trim();
    return fromEnv && fromEnv.length > 0 ? resolve(fromEnv) : process.cwd();
}
export function configPathIn(repoDir) {
    return resolve(repoDir, '.axtar', 'config.yml');
}
/**
 * Walk up from `startDir` for the nearest `.axtar/config.yml`.
 *
 * Upward, because an agent's working directory is routinely a package inside
 * the repo (`apps/web`) while the config lives at the root; refusing there
 * would read as "Axtar is not set up" in a repo where it plainly is.
 */
export function findConfigFile(startDir) {
    let dir = resolve(startDir);
    for (;;) {
        const candidate = configPathIn(dir);
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Take the scalar after `project:`, minus quotes and any trailing comment.
 * Returns null for an empty value.
 */
function scalarValue(raw) {
    const text = raw.trim();
    if (text.length === 0)
        return null;
    const quote = text[0];
    if (quote === '"' || quote === "'") {
        const closing = text.indexOf(quote, 1);
        // An unterminated quote is a config the platform will reject anyway; take
        // what is there rather than inventing a repair.
        const value = closing === -1 ? text.slice(1) : text.slice(1, closing);
        return value.length > 0 ? value : null;
    }
    // `project:   # TODO` is a comment, not a value — the binding is empty.
    if (text.startsWith('#'))
        return null;
    // Elsewhere an unquoted `#` only starts a comment when it follows whitespace.
    const comment = text.search(/\s#/);
    const value = (comment === -1 ? text : text.slice(0, comment)).trim();
    return value.length > 0 ? value : null;
}
/**
 * The top-level `project:` value in a `.axtar/config.yml`, or null.
 *
 * Exported for tests and for any caller holding the text already — the file
 * reading lives in `loadRepoBinding`.
 */
export function readProjectId(text) {
    for (const line of text.split(/\r?\n/)) {
        // Indented lines belong to a nested mapping (`knowledge.code.include`);
        // only the document's own keys can carry the binding.
        if (/^\s/.test(line))
            continue;
        const match = /^project\s*:(.*)$/.exec(line);
        if (match)
            return scalarValue(match[1] ?? '');
    }
    return null;
}
/** The repo's binding, or the precise reason there isn't one. Never throws. */
export function loadRepoBinding(startDir = resolveRepoDir()) {
    const configPath = findConfigFile(startDir);
    if (configPath === null) {
        return { ok: false, reason: 'no_config', searchedFrom: resolve(startDir) };
    }
    let text;
    try {
        text = readFileSync(configPath, 'utf-8');
    }
    catch (err) {
        return {
            ok: false,
            reason: 'unreadable',
            configPath,
            detail: err instanceof Error ? err.message : String(err),
        };
    }
    const projectId = readProjectId(text);
    if (projectId === null) {
        return { ok: false, reason: 'no_project', configPath };
    }
    return { ok: true, binding: { projectId, configPath } };
}
/**
 * What to tell the agent when this repo is not bound — the refusal the tools
 * answer with instead of checking against nothing (spec §15).
 */
export function bindingInstructions(result) {
    switch (result.reason) {
        case 'no_config':
            return (`No ${CONFIG_RELATIVE_PATH} found at or above ${result.searchedFrom}, so no Axtar project ` +
                `governs this repo. Create the project in the Axtar portal, commit the config it generates, ` +
                `and run the check again.`);
        case 'no_project':
            return (`${result.configPath} has no top-level 'project:' value, so this repo is bound to nothing. ` +
                `Copy the project id from the Axtar portal into it.`);
        case 'unreadable':
            return `${result.configPath} could not be read: ${result.detail}`;
    }
}
//# sourceMappingURL=config.js.map