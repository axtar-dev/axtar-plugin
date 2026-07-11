/**
 * Edit-simulator vs. real Claude Code Edit — divergence detector
 * (Phase 4 plan §5).
 *
 * The plugin's PreToolUse hook fires BEFORE the edit lands on disk, so
 * `applyEdit` simulates Claude Code's Edit/Write semantics in memory to
 * compute `file_after`. If the simulator diverges from the actual Edit
 * tool, the engine evaluates wrong content — false negatives on real
 * violations, false positives on clean edits, and (worst) noisy
 * rejections that erode trust. This file pins simulator behavior
 * against real-Edit ground truth.
 *
 * Capture path: **A**.
 *
 * Method: each fixture under `plugin/test/fixtures/edit_capture/<case>/`
 * contains a `file_before.java` (the pre-edit state) and a
 * `file_after.observed.java` produced by invoking the real Edit tool
 * during this Step 6 capture session, plus an `edit.json` recording
 * the exact tool params used. The captures were produced inside the
 * Claude Code session that is itself a production Edit consumer — so
 * the recorded `file_after` is what production semantics yield, not
 * what spec docs say they yield. Path B (codify documented semantics)
 * was held in reserve and not needed.
 *
 * Test contract: for each case, run the simulator with the recorded
 * `edit.json` against the recorded `file_before.java` and assert the
 * result equals `file_after.observed.java` byte-for-byte. If a future
 * test fails here, **fix the simulator, not the test** — the
 * captured file is ground truth, the simulator is what runs in the
 * hot path.
 *
 * Not gated by `RUN_INTEGRATION` — pure-fs comparison, no live engine
 * dependency. Lives in `test/integration/` per Phase 4 plan path
 * convention.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { applyEdit, type EditInput } from '../../src/shared/edit/apply.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(here, '..', 'fixtures', 'edit_capture');

interface CaptureManifest {
  tool: 'Edit';
  file_path: string; // relative to the case fixture dir
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function loadCases(): string[] {
  return readdirSync(FIXTURES_ROOT)
    .filter((name) => statSync(resolve(FIXTURES_ROOT, name)).isDirectory())
    .sort();
}

describe('edit-simulator divergence (capture path A)', () => {
  const cases = loadCases();

  // Defensive: if the fixtures directory is empty or missing, fail loudly
  // rather than silently passing a zero-case parametric test.
  it('discovers at least three captured cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  for (const caseId of cases) {
    it(`${caseId}: simulator output matches real-Edit ground truth byte-for-byte`, () => {
      const caseDir = resolve(FIXTURES_ROOT, caseId);
      const manifestRaw = readFileSync(resolve(caseDir, 'edit.json'), 'utf-8');
      const manifest = JSON.parse(manifestRaw) as CaptureManifest;
      const beforePath = resolve(caseDir, manifest.file_path);
      const observed = readFileSync(resolve(caseDir, 'file_after.observed.java'), 'utf-8');

      const input: EditInput = {
        file_path: beforePath,
        old_string: manifest.old_string,
        new_string: manifest.new_string,
        ...(manifest.replace_all !== undefined ? { replace_all: manifest.replace_all } : {}),
      };

      const outcome = applyEdit(input);
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return; // narrows for the asserts below

      expect(outcome.file_after).toBe(observed);
      expect(outcome.file_after.length).toBe(observed.length);
    });
  }
});
