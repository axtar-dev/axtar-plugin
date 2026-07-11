import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configPath,
  readConfig,
  saveProjectSelection,
  selectedProjectId,
} from '../../src/shared/project/config.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'axtar-proj-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const PROJECT = { id: 'proj-123', name: 'Demo' };

describe('project config', () => {
  it('readConfig returns null when no config exists', () => {
    expect(readConfig(workDir)).toBeNull();
    expect(selectedProjectId(workDir)).toBeNull();
  });

  it('saveProjectSelection persists the chosen project', () => {
    saveProjectSelection(workDir, PROJECT, '2026-06-23T00:00:00Z');

    // Persisted to disk as committed JSON.
    expect(existsSync(configPath(workDir))).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath(workDir), 'utf-8'));
    expect(onDisk.project).toEqual(PROJECT);
    expect(onDisk.updatedAt).toBe('2026-06-23T00:00:00Z');
    expect(selectedProjectId(workDir)).toBe('proj-123');
  });

  it('re-selecting overwrites the previous choice', () => {
    saveProjectSelection(workDir, PROJECT, '2026-06-23T00:00:00Z');
    saveProjectSelection(workDir, { id: 'proj-999', name: 'Other' }, '2026-06-24T00:00:00Z');
    expect(selectedProjectId(workDir)).toBe('proj-999');
  });

  it('readConfig tolerates a malformed project block (treats as unselected)', () => {
    saveProjectSelection(workDir, PROJECT, '2026-06-23T00:00:00Z');
    writeFileSync(
      configPath(workDir),
      JSON.stringify({ project: { id: 'x' }, updatedAt: '2026-06-23T00:00:00Z' }),
      'utf-8',
    );
    const cfg = readConfig(workDir);
    expect(cfg).not.toBeNull();
    expect(cfg?.project).toBeNull();
    expect(selectedProjectId(workDir)).toBeNull();
  });

  it('readConfig returns null on non-JSON garbage', () => {
    saveProjectSelection(workDir, PROJECT, '2026-06-23T00:00:00Z');
    writeFileSync(configPath(workDir), 'not json at all', 'utf-8');
    expect(readConfig(workDir)).toBeNull();
  });
});
