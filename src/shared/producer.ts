/**
 * The **local packet producer** (spec §9, §15).
 *
 * `axtar_check_diff` takes no diff and no file contents from the agent. This
 * module is why: the working tree is authoritative and already on disk, so the
 * server assembles the packet itself — resolve a base ref, run `git diff`, read
 * the changed files whole — and uploads once. An agent hand-copying file
 * contents burns its own context and gets it wrong, and the packet it builds
 * would differ from the one CI's server-side producer builds from the same
 * commit, which is the fastest way to make the two surfaces disagree.
 *
 * **Two packets, one discipline.** `producePacket` answers "what changed";
 * `produceScanPacket` answers "what is in these files, right now" — the scan
 * surface has no base and no diff, so its whole input is a set of globs expanded
 * against the work tree. Both read the same way (whole files, lstat'd, binaries
 * dropped) and both leave every size decision to the platform.
 *
 * **The base-ref ladder**, in order, first rung that resolves wins:
 *
 * 1. the caller's explicit `base_ref` — used as given (two-dot: `git diff <ref>`);
 * 2. `merge-base(HEAD, origin/HEAD)` — the remote's default branch, read from
 *    the `refs/remotes/origin/HEAD` symbolic ref;
 * 3. `merge-base(HEAD, origin/main)` — for clones where nothing ever set
 *    `origin/HEAD` (a plain `git fetch` does not);
 * 4. `merge-base(HEAD, main)` — the local branch, for repos with no remote at all.
 *
 * Nothing resolves → refuse and say so. Diffing against the root commit would
 * ship the whole repository as "the change", which is worse than an actionable
 * "pass base_ref explicitly".
 *
 * The base ref that goes on the wire is always the **resolved sha**: a branch
 * name moves, and the check record has to say which text was reviewed.
 *
 * **What counts as changed:** everything `git diff <base>` reports (staged and
 * unstaged alike — uncommitted work getting checked is the point of the local
 * surface), plus every **untracked** file `git status` reports. A new file the
 * agent just wrote is the most review-worthy thing in the tree; leaving it out
 * because it has never been `git add`ed would be a silent hole. Untracked text
 * files are also synthesised into the uploaded diff as new-file hunks — cheap,
 * deterministic, and it keeps the artifact shaped like the one CI produces from
 * a commit (minus git's `index` line, which needs blob hashes we have not
 * written). Untracked *binaries* are not synthesised and not uploaded.
 *
 * **The only thing dropped client-side is binary content**, with a stderr note.
 * Size is the platform's call: it owns the packet cap and answers a cap it hit
 * by naming the `dropped` rules (invariant #9). A producer that silently
 * trimmed files would turn that into a clean verdict over evidence nobody saw.
 *
 * Every git call goes through `execFile` with an argv list — no shell, so a
 * branch name with a space or a `;` in it is an argument, never a command.
 */

import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { log } from './log.js';
import type { PacketFile } from './wire/checks.js';

const execFileAsync = promisify(execFile);

/** Diffs of a large change are large; the cap is a guard, not a budget. */
const MAX_GIT_BUFFER = 256 * 1024 * 1024;

/** A NUL in the first bytes is how git itself calls a file binary. */
const BINARY_SNIFF_BYTES = 8000;

/** Rungs 2–4 of the base-ref ladder, in order. */
export const DEFAULT_BRANCH_LADDER = ['origin/HEAD', 'origin/main', 'main'] as const;

export type ProducerFailureReason =
  /** `git rev-parse --show-toplevel` failed — not a git work tree (or no git). */
  | 'not_a_repo'
  /** `HEAD` does not resolve: a repo with no commits yet. */
  | 'no_commits'
  /** The caller's `base_ref` is not a ref this repo knows. */
  | 'unknown_base_ref'
  /** Nothing on the ladder resolved; the caller must name a base. */
  | 'no_base_ref'
  /** A scan's paths/globs expanded to nothing this producer could send. */
  | 'no_files_matched'
  /** git ran and failed (a broken repo, a killed process, an over-large diff). */
  | 'git_failed';

/** Why a packet could not be built — local, actionable, and never a verdict. */
export interface ProducerFailure {
  ok: false;
  reason: ProducerFailureReason;
  detail: string;
}

export type ProducerOutcome<T> = { ok: true; value: T } | ProducerFailure;

export interface BaseRef {
  /** The commit the diff is taken against — always resolved to a sha. */
  sha: string;
  /** How it was chosen, for the stderr note and the packet line. */
  label: string;
}

/**
 * What `axtar_check_scan` ships: existing files, exactly as the tree holds them.
 *
 * Field names follow the wire (`api/app/schemas/plugin/check.py::
 * ScanCheckRequest`) where the wire owns them — `paths_requested` goes up
 * verbatim, so it is spelled the way the platform records it.
 */
export interface ScanPacket {
  /** Full working-tree content of every file the globs resolved to. */
  files: PacketFile[];
  /** The globs the caller asked for, verbatim — the platform records them. */
  paths_requested: string[];
  /** Paths that matched and were left out because they are binary. */
  skipped_binary: string[];
}

export interface DiffPacket {
  /** Absolute path of the work tree the packet was built from. */
  repoRoot: string;
  /** The resolved base commit — this is what goes on the wire as `base_ref`. */
  baseRef: string;
  /** Human-readable provenance of `baseRef` (which ladder rung answered). */
  baseRefLabel: string;
  /** `git diff <base>` plus synthesised new-file hunks for untracked text. */
  diff: string;
  /** Full working-tree content of every changed + untracked file that exists. */
  files: PacketFile[];
  /** The current branch, or null when detached / unborn. */
  branch: string | null;
  /** Paths excluded from `files` because they are binary. */
  binarySkipped: string[];
  /** Untracked paths folded into the packet. */
  untracked: string[];
}

export interface ProduceOptions {
  /** Where to look for the repo; the root is discovered upward from here. */
  cwd: string;
  /** The caller's explicit base ref, if they named one. */
  baseRef?: string | undefined;
}

// --- git plumbing ------------------------------------------------------------

type GitOutcome = { ok: true; stdout: string } | { ok: false; detail: string };

async function git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: MAX_GIT_BUFFER,
      // Reading a work tree must never take (or wait for) the index lock.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, detail: gitErrorDetail(err) };
  }
}

function gitErrorDetail(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/** The work tree root containing `cwd`, so every later git call is root-relative. */
export async function findRepoRoot(cwd: string): Promise<ProducerOutcome<string>> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!out.ok) {
    return { ok: false, reason: 'not_a_repo', detail: out.detail };
  }
  return { ok: true, value: resolve(out.stdout.trim()) };
}

/** The sha `ref` points at, or null when this repo does not know it. */
async function revParse(repoRoot: string, ref: string): Promise<string | null> {
  const out = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!out.ok) return null;
  const sha = out.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** `origin`'s default branch as a ref name (`origin/main`), or null. */
async function originHead(repoRoot: string): Promise<string | null> {
  const out = await git(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (!out.ok) return null;
  const full = out.stdout.trim();
  return full.startsWith('refs/remotes/') ? full.slice('refs/remotes/'.length) : null;
}

async function mergeBase(repoRoot: string, a: string, b: string): Promise<string | null> {
  const out = await git(repoRoot, ['merge-base', a, b]);
  if (!out.ok) return null;
  const sha = out.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** The branch `ref` defaults to. Null when detached (`HEAD`) or unborn. */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  const out = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!out.ok) return null;
  const name = out.stdout.trim();
  return name.length > 0 && name !== 'HEAD' ? name : null;
}

// --- the ladder --------------------------------------------------------------

export async function resolveBaseRef(
  repoRoot: string,
  explicit?: string | undefined,
): Promise<ProducerOutcome<BaseRef>> {
  if (explicit !== undefined && explicit.trim().length > 0) {
    const ref = explicit.trim();
    const sha = await revParse(repoRoot, ref);
    if (sha === null) {
      return {
        ok: false,
        reason: 'unknown_base_ref',
        detail: `git does not know the ref '${ref}' in ${repoRoot}`,
      };
    }
    return { ok: true, value: { sha, label: `${ref} (explicit)` } };
  }

  if ((await revParse(repoRoot, 'HEAD')) === null) {
    return {
      ok: false,
      reason: 'no_commits',
      detail: `HEAD does not resolve in ${repoRoot} — the repository has no commits yet`,
    };
  }

  for (const rung of DEFAULT_BRANCH_LADDER) {
    const name = rung === 'origin/HEAD' ? await originHead(repoRoot) : rung;
    if (name === null) continue;
    if ((await revParse(repoRoot, name)) === null) continue;
    const base = await mergeBase(repoRoot, 'HEAD', name);
    // Unrelated histories have no merge base; try the next rung rather than
    // pretending this one answered.
    if (base === null) continue;
    return { ok: true, value: { sha: base, label: `merge-base of HEAD and ${name}` } };
  }

  return {
    ok: false,
    reason: 'no_base_ref',
    detail:
      `no default branch found in ${repoRoot} (tried ${DEFAULT_BRANCH_LADDER.join(', ')}) — ` +
      `pass base_ref explicitly`,
  };
}

// --- changed paths -----------------------------------------------------------

function splitZ(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

async function changedPaths(repoRoot: string, base: string): Promise<ProducerOutcome<string[]>> {
  const out = await git(repoRoot, ['diff', '--name-only', '-z', base, '--']);
  if (!out.ok) return { ok: false, reason: 'git_failed', detail: out.detail };
  return { ok: true, value: splitZ(out.stdout) };
}

/**
 * Untracked paths, one entry per file (`--untracked-files=all`, so a new
 * directory is not collapsed to a single `dir/` entry).
 *
 * `-z` is not a nicety: without it git quotes paths with spaces or non-ASCII
 * characters, and the unquoting is the producer's to get wrong. In `-z` porcelain
 * v1 a rename emits two records (`R  <new>\0<old>`), so the source record is
 * consumed and skipped.
 */
async function untrackedPaths(repoRoot: string): Promise<ProducerOutcome<string[]>> {
  const out = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!out.ok) return { ok: false, reason: 'git_failed', detail: out.detail };

  const records = out.stdout.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined || record.length < 4) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const path = record.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1; // the rename/copy source rides in the next record
    }
    if (x === '?' && y === '?') paths.push(path);
  }
  return { ok: true, value: paths };
}

// --- file contents -----------------------------------------------------------

function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

interface ReadFileResult {
  content: string | null;
  /** Set when the path exists but was left out: `binary`, or not a regular file. */
  skipped: 'binary' | 'not_a_file' | 'missing' | null;
  executable: boolean;
}

function readWorkTreeFile(repoRoot: string, path: string): ReadFileResult {
  const absolute = resolve(repoRoot, path);
  let stat;
  try {
    // lstat, not stat: a symlink's *target* is not this repo's content, and
    // following one out of the tree would upload a file nobody changed.
    stat = lstatSync(absolute);
  } catch {
    return { content: null, skipped: 'missing', executable: false };
  }
  if (!stat.isFile()) {
    return { content: null, skipped: 'not_a_file', executable: false };
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return { content: null, skipped: 'missing', executable: false };
  }
  const executable = (stat.mode & 0o111) !== 0;
  if (looksBinary(buffer)) {
    return { content: null, skipped: 'binary', executable };
  }
  return { content: buffer.toString('utf-8'), skipped: null, executable };
}

/**
 * A new-file hunk for an untracked file, in git's own unified format minus the
 * `index <blob>..<blob>` line (which would need hashes of blobs that do not
 * exist yet). Empty files get the header only — the same thing git emits.
 */
export function newFileHunk(path: string, content: string, executable: boolean): string {
  const mode = executable ? '100755' : '100644';
  const header = `diff --git a/${path} b/${path}\nnew file mode ${mode}\n`;
  if (content.length === 0) return header;

  const trailingNewline = content.endsWith('\n');
  const body = trailingNewline ? content.slice(0, -1) : content;
  const lines = body.split('\n');
  const out = [header, '--- /dev/null\n', `+++ b/${path}\n`, `@@ -0,0 +1,${lines.length} @@\n`];
  for (const line of lines) out.push(`+${line}\n`);
  if (!trailingNewline) out.push('\\ No newline at end of file\n');
  return out.join('');
}

// --- the packet --------------------------------------------------------------

/** Assemble the diff packet for `cwd`'s repository. Never throws. */
export async function producePacket(options: ProduceOptions): Promise<ProducerOutcome<DiffPacket>> {
  const root = await findRepoRoot(options.cwd);
  if (!root.ok) return root;
  const repoRoot = root.value;

  const base = await resolveBaseRef(repoRoot, options.baseRef);
  if (!base.ok) return base;

  const diff = await git(repoRoot, ['diff', base.value.sha, '--']);
  if (!diff.ok) return { ok: false, reason: 'git_failed', detail: diff.detail };

  const changed = await changedPaths(repoRoot, base.value.sha);
  if (!changed.ok) return changed;

  const untracked = await untrackedPaths(repoRoot);
  if (!untracked.ok) return untracked;

  const untrackedSet = new Set(untracked.value);
  const paths = [...new Set([...changed.value, ...untracked.value])].sort();

  const files: PacketFile[] = [];
  const binarySkipped: string[] = [];
  const synthesized: string[] = [];
  let extraDiff = '';

  for (const path of paths) {
    const read = readWorkTreeFile(repoRoot, path);
    if (read.skipped === 'binary') {
      binarySkipped.push(path);
      continue;
    }
    // Deleted (and never-existing) paths live in the diff and nowhere else;
    // a directory or symlink entry carries no content to review.
    if (read.content === null) continue;

    files.push({ path, content: read.content });
    if (untrackedSet.has(path)) {
      extraDiff += newFileHunk(path, read.content, read.executable);
      synthesized.push(path);
    }
  }

  const gitDiff =
    diff.stdout.length === 0 || diff.stdout.endsWith('\n') ? diff.stdout : `${diff.stdout}\n`;

  if (binarySkipped.length > 0) {
    log.warn('binary files excluded from the packet', { paths: binarySkipped });
  }
  log.debug('packet assembled', {
    repoRoot,
    base: base.value.sha,
    baseFrom: base.value.label,
    files: files.length,
    untracked: synthesized.length,
    binarySkipped: binarySkipped.length,
  });

  return {
    ok: true,
    value: {
      repoRoot,
      baseRef: base.value.sha,
      baseRefLabel: base.value.label,
      diff: `${gitDiff}${extraDiff}`,
      files,
      branch: await currentBranch(repoRoot),
      binarySkipped,
      untracked: synthesized,
    },
  };
}

// --- the scan packet ---------------------------------------------------------

/**
 * `git ls-files` under one set of pathspecs, `-z` so a path with a space in it
 * is a path and not two.
 *
 * The pathspecs go after `--` as separate argv entries, never interpolated into
 * a string: `execFile` means a glob is expanded by git's own pathspec matcher
 * and by no shell, so `src/*; rm -rf /` is a (fruitless) pathspec.
 */
async function listFiles(
  repoRoot: string,
  flags: readonly string[],
  globs: readonly string[],
): Promise<ProducerOutcome<string[]>> {
  const out = await git(repoRoot, ['ls-files', ...flags, '-z', '--', ...globs]);
  if (!out.ok) return { ok: false, reason: 'git_failed', detail: out.detail };
  return { ok: true, value: splitZ(out.stdout) };
}

/**
 * Assemble the scan packet for `paths` in `repoRoot`. Never throws.
 *
 * **What a scan covers:** everything `git ls-files` reports under the given
 * pathspecs (tracked), plus everything `git ls-files --others
 * --exclude-standard` reports under the same ones (untracked but *not*
 * ignored). A file the agent wrote ten seconds ago is the most audit-worthy
 * thing under a glob and has never been `git add`ed; a `node_modules/` entry
 * `.gitignore` already excludes is not the team's code and would burn the
 * packet cap on somebody else's.
 *
 * **Zero matches is a refusal, not an empty packet.** The platform requires a
 * non-empty `files` (a scan of nothing answered `clean` is the exact lie
 * invariant #9 forbids), and a typo'd glob is the overwhelmingly likely cause —
 * so the caller is told to fix the glob rather than handed a verdict.
 *
 * **The only thing dropped here is binary content.** There is no size decision
 * in this function on purpose: the platform owns the packet cap and answers one
 * it hit by naming the `dropped` rules.
 */
export async function produceScanPacket(
  repoRoot: string,
  paths: readonly string[],
): Promise<ProducerOutcome<ScanPacket>> {
  // git gets the trimmed globs; `paths_requested` keeps what the caller typed,
  // because that is what the platform records the scan as having been asked for.
  const globs = paths.map((glob) => glob.trim()).filter((glob) => glob.length > 0);
  const requested = [...paths];
  if (globs.length === 0) {
    return {
      ok: false,
      reason: 'no_files_matched',
      detail: 'no paths were given — a scan needs at least one file or glob to audit',
    };
  }

  const tracked = await listFiles(repoRoot, [], globs);
  if (!tracked.ok) return tracked;
  const untracked = await listFiles(repoRoot, ['--others', '--exclude-standard'], globs);
  if (!untracked.ok) return untracked;

  const matched = [...new Set([...tracked.value, ...untracked.value])].sort();
  if (matched.length === 0) {
    return {
      ok: false,
      reason: 'no_files_matched',
      detail: `no files matched — check the paths/globs (asked for: ${globs.join(', ')})`,
    };
  }

  const files: PacketFile[] = [];
  const skippedBinary: string[] = [];
  for (const path of matched) {
    const read = readWorkTreeFile(repoRoot, path);
    if (read.skipped === 'binary') {
      skippedBinary.push(path);
      continue;
    }
    // A tracked path deleted from the tree, a directory, a symlink: nothing to
    // audit, and nothing the platform could quote back as evidence.
    if (read.content === null) continue;
    files.push({ path, content: read.content });
  }

  if (files.length === 0) {
    return {
      ok: false,
      reason: 'no_files_matched',
      detail:
        `no files matched — check the paths/globs: ${matched.length} path(s) matched but none ` +
        `carried readable text (${skippedBinary.length} binary)`,
    };
  }

  if (skippedBinary.length > 0) {
    log.warn('binary files excluded from the scan packet', { paths: skippedBinary });
  }
  log.debug('scan packet assembled', {
    repoRoot,
    requested: requested.length,
    matched: matched.length,
    files: files.length,
    binarySkipped: skippedBinary.length,
  });

  return {
    ok: true,
    value: { files, paths_requested: requested, skipped_binary: skippedBinary },
  };
}
