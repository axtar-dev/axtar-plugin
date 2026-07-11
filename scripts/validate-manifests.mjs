// Lightweight, dependency-free manifest guard for CI (and local pre-release).
//
// Mirrors the invariants `claude plugin validate --strict` and `claude plugin
// tag` enforce, without needing the Claude Code CLI installed in CI:
//   1. .claude-plugin/plugin.json and package.json declare the SAME version
//      (claude plugin tag refuses to tag when they disagree).
//   2. .claude-plugin/marketplace.json has the fields --strict requires
//      (name, description, owner.name, non-empty plugins[] with name + source
//      + description).
//   3. The marketplace entry for this plugin agrees with plugin.json's name.
//
// Run `claude plugin validate --strict .` locally for the authoritative check;
// this script is the deterministic CI stand-in. Exits non-zero on any failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
  } catch (e) {
    errors.push(`${rel}: not readable / not valid JSON (${e.message})`);
    return null;
  }
}

const plugin = readJson('.claude-plugin/plugin.json');
const pkg = readJson('package.json');
const market = readJson('.claude-plugin/marketplace.json');

// 1. Version agreement.
if (plugin && pkg) {
  if (typeof plugin.version !== 'string') errors.push('plugin.json: missing string `version`');
  if (typeof pkg.version !== 'string') errors.push('package.json: missing string `version`');
  if (plugin.version && pkg.version && plugin.version !== pkg.version) {
    errors.push(
      `version mismatch: plugin.json=${plugin.version} vs package.json=${pkg.version} ` +
        `(claude plugin tag requires them equal)`,
    );
  }
}
if (plugin && typeof plugin.name !== 'string') errors.push('plugin.json: missing string `name`');

// 2. Marketplace required fields.
if (market) {
  if (typeof market.name !== 'string') errors.push('marketplace.json: missing string `name`');
  if (typeof market.description !== 'string' || market.description.trim() === '') {
    errors.push('marketplace.json: missing non-empty `description` (--strict treats this as an error)');
  }
  if (!market.owner || typeof market.owner.name !== 'string') {
    errors.push('marketplace.json: missing `owner.name`');
  }
  if (!Array.isArray(market.plugins) || market.plugins.length === 0) {
    errors.push('marketplace.json: `plugins` must be a non-empty array');
  } else {
    market.plugins.forEach((p, i) => {
      if (typeof p.name !== 'string') errors.push(`marketplace.json: plugins[${i}] missing \`name\``);
      if (p.source === undefined) errors.push(`marketplace.json: plugins[${i}] missing \`source\``);
      if (typeof p.description !== 'string') {
        errors.push(`marketplace.json: plugins[${i}] missing \`description\``);
      }
    });
    // 3. Entry for this plugin agrees with plugin.json name.
    if (plugin && typeof plugin.name === 'string') {
      const match = market.plugins.find((p) => p.name === plugin.name);
      if (!match) {
        errors.push(
          `marketplace.json: no plugins[] entry named "${plugin.name}" (from plugin.json)`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error('✘ manifest validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✔ manifests valid — ${plugin?.name}@${plugin?.version} (plugin.json == package.json)`);
