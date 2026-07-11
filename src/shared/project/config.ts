/**
 * Per-repository Axtar config — the source of truth for which project this
 * repo is bound to. Persisted at `<projectDir>/.axtar/config.json` and meant
 * to be committed, so the binding travels with the repo.
 *
 * A *project* is the platform-side artifact that owns a pool of rules
 * (`GET /mentor/projects`). Binding a repo to a project is what scopes
 * evaluation: the hooks pass the selected `project.id` to `GET /mentor/rules`
 * and only that project's pool (plus the org constitution, merged
 * server-side) is enforced. The binding lives entirely in this file — the
 * platform keeps no per-repo record.
 *
 * Read/write here is fail-soft for the hot hook path: a missing or malformed
 * config means "no project selected", never a thrown error that could break a
 * developer's edit (non-negotiable #4).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface BoundProject {
  id: string;
  name: string;
}

export interface ProjectConfig {
  version: 1;
  project: BoundProject | null;
  updatedAt: string | null;
}

const CONFIG_VERSION = 1 as const;

/** The repo root we read/write config against. Mirrors the runner's rule. */
export function resolveProjectDir(): string {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd();
}

export function configPath(projectDir: string): string {
  return resolve(projectDir, '.axtar', 'config.json');
}

/** Read the committed config, or null if absent/unparseable. Never throws. */
export function readConfig(projectDir: string): ProjectConfig | null {
  const path = configPath(projectDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProjectConfig>;
    const project =
      parsed.project &&
      typeof parsed.project.id === 'string' &&
      typeof parsed.project.name === 'string'
        ? { id: parsed.project.id, name: parsed.project.name }
        : null;
    return {
      version: CONFIG_VERSION,
      project,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

export function writeConfig(projectDir: string, config: ProjectConfig): void {
  const path = configPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Persist a project choice. Returns the saved config. */
export function saveProjectSelection(
  projectDir: string,
  project: BoundProject,
  now: string,
): ProjectConfig {
  const next: ProjectConfig = {
    version: CONFIG_VERSION,
    project,
    updatedAt: now,
  };
  writeConfig(projectDir, next);
  return next;
}

/** The selected project id for hook scoping, or null when none is bound. */
export function selectedProjectId(projectDir: string): string | null {
  return readConfig(projectDir)?.project?.id ?? null;
}
