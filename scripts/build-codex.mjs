// Assemble the clean codex plugin install tree under plugin/codex-build/axtar/.
//
// Phase 4 Step 11.5.5b restructure. Codex's marketplace install copies the
// entire `source.path` directory verbatim into ~/.codex/plugins/cache/... —
// pointing it at plugin/ directly ships ~100MB (node_modules + dev tooling +
// TS source + test fixtures) per developer. This script produces a clean
// codex-only tree: .codex-plugin/ + the codex-reachable dist/ subtree
// (hosts/codex + shared, derived from the compiled import graph; NO
// hosts/claude-code) + node_modules/zod (the only third-party runtime dep
// per `plugin/package.json` `dependencies`) + a stripped runtime
// package.json. ~5.5MB total install footprint.
//
// Drift discipline: name, version, type, engines, and the zod version are
// read from the source `plugin/package.json` at build time so a bump there
// propagates automatically. No hardcoded version constants in this script.
//
// Assumes `npm run build` (tsc) has produced `plugin/dist/` already;
// invoked via `npm run build:codex` which chains the tsc build first.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Keep the codex install tree inside the plugin so the plugin is fully
// self-contained (platform/plugin/codex-build/axtar). Gitignored build output.
const OUT = resolve(PLUGIN_DIR, 'codex-build/axtar');

const sourcePkg = JSON.parse(readFileSync(resolve(PLUGIN_DIR, 'package.json'), 'utf8'));
const zodVersion = sourcePkg.dependencies?.zod;
if (!zodVersion) {
  throw new Error('build-codex: plugin/package.json has no `dependencies.zod` entry — expected the sole codex runtime dep');
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Manifest stays under .codex-plugin/ — the canonical manifest location
// codex looks for at install time.
mkdirSync(resolve(OUT, '.codex-plugin'), { recursive: true });
cpSync(
  resolve(PLUGIN_DIR, '.codex-plugin/plugin.json'),
  resolve(OUT, '.codex-plugin/plugin.json'),
);

// Hooks config lands at <plugin-root>/hooks/hooks.json. plugin.json's
// "./hooks/hooks.json" is resolved by codex relative to the plugin root
// (NOT relative to plugin.json's own directory) per codex's plugin-root
// path convention — see [[D-043]]. The source keeps hooks under
// .codex-plugin/hooks/ for per-host namespacing alongside the manifest;
// this build translates that into the codex install-tree layout the
// spec requires. Companion paths in plugin.json (skills/, apps/,
// mcpServers/) follow the same rule if added later.
mkdirSync(resolve(OUT, 'hooks'), { recursive: true });
cpSync(
  resolve(PLUGIN_DIR, '.codex-plugin/hooks/hooks.json'),
  resolve(OUT, 'hooks/hooks.json'),
);

// dist/hosts/codex + dist/shared — the codex-reachable surface derived from
// the compiled import graph. dist/hosts/claude-code is excluded by omission.
cpSync(resolve(PLUGIN_DIR, 'dist/hosts/codex'), resolve(OUT, 'dist/hosts/codex'), {
  recursive: true,
});
cpSync(resolve(PLUGIN_DIR, 'dist/shared'), resolve(OUT, 'dist/shared'), {
  recursive: true,
});

// dist/cli — the `axtar-rulesets` selection CLI (imports only from dist/shared,
// already copied above). Lets codex users bind a repo to a ruleset with
// `node <plugin-root>/dist/cli/rulesets.js select <slug>`.
cpSync(resolve(PLUGIN_DIR, 'dist/cli'), resolve(OUT, 'dist/cli'), {
  recursive: true,
});

// node_modules/zod — the only third-party runtime dep. Other entries under
// plugin/node_modules/ are devDependencies and are intentionally not copied.
cpSync(resolve(PLUGIN_DIR, 'node_modules/zod'), resolve(OUT, 'node_modules/zod'), {
  recursive: true,
});

// Stripped runtime package.json — every field read from source, no
// duplicate constants in this file.
const runtimePkg = {
  name: sourcePkg.name,
  version: sourcePkg.version,
  type: sourcePkg.type,
  engines: sourcePkg.engines,
  dependencies: { zod: zodVersion },
};
writeFileSync(resolve(OUT, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);

console.log(`built codex install tree at ${OUT}`);
console.log(`  version ${runtimePkg.version}, zod ${zodVersion}, engines.node ${runtimePkg.engines?.node}`);
