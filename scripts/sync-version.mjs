// Single source of truth for the version: package.json.
//
// Claude Code reads the version from .claude-plugin/plugin.json; npm reads it
// from package.json. Rather than hand-edit both (and drift), `npm version`
// bumps package.json and runs this in its `version` lifecycle hook to copy the
// new value into plugin.json so the two never disagree.
//
// Idempotent: a no-op when they already match. Preserves plugin.json key order
// and 2-space formatting.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const pluginPath = resolve(ROOT, '.claude-plugin/plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));

if (typeof pkg.version !== 'string') {
  console.error('sync-version: package.json has no string `version`');
  process.exit(1);
}

if (plugin.version === pkg.version) {
  console.log(`sync-version: plugin.json already at ${pkg.version}`);
  process.exit(0);
}

plugin.version = pkg.version;
writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`sync-version: plugin.json → ${pkg.version}`);
