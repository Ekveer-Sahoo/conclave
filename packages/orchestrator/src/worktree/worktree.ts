import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Thrown when the selected path is not a Git repository, or has no valid HEAD commit. */
export class InvalidRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepositoryError";
  }
}

/** Thrown when the source repository has uncommitted changes and dirty sources were not opted into. */
export class DirtySourceRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirtySourceRepositoryError";
  }
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseCommit: string;
  sourceCwd: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: env ?? process.env, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Validates the path is a Git repository with a valid HEAD and returns the HEAD commit sha. */
export async function assertValidRepository(cwd: string): Promise<string> {
  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside.trim() !== "true") {
      throw new InvalidRepositoryError(`${cwd} is not a Git working tree`);
    }
  } catch (error) {
    if (error instanceof InvalidRepositoryError) throw error;
    throw new InvalidRepositoryError(`${cwd} is not a Git repository: ${(error as Error).message}`);
  }
  try {
    const head = await git(["rev-parse", "HEAD"], cwd);
    const sha = head.trim();
    if (!sha) throw new Error("empty HEAD");
    return sha;
  } catch (error) {
    throw new InvalidRepositoryError(`${cwd} has no valid HEAD commit: ${(error as Error).message}`);
  }
}

/**
 * Refuses to proceed if the source repository has uncommitted changes (tracked or untracked).
 * Conclave's own state directory (`.conclave/`, which holds the event store) is excluded: the
 * first run creates it, and it must not make every later run look like a dirty checkout.
 */
export async function assertCleanRepository(cwd: string): Promise<void> {
  const status = await git(["status", "--porcelain", "--", ".", ":(exclude).conclave"], cwd);
  if (status.trim().length > 0) {
    throw new DirtySourceRepositoryError(
      `${cwd} has uncommitted changes; refusing to run against a dirty source repository`,
    );
  }
}

/** Creates a linked worktree and branch outside the source repository for this session. */
export async function createWorktree(sourceCwd: string, sessionId: string, baseCommit: string): Promise<WorktreeHandle> {
  // Per spec this is the literal /tmp path, not os.tmpdir() — on macOS the latter resolves to a
  // per-user /var/folders/... directory, not /tmp.
  const path = `/tmp/conclave-${sessionId}`;
  const branch = `conclave/${sessionId}`;
  await git(["worktree", "add", "-b", branch, path, baseCommit], sourceCwd);
  return { path, branch, baseCommit, sourceCwd };
}

/**
 * Computes a full tree hash of the worktree's current working state — including untracked,
 * gitignore-respecting files — without touching the real index, via a scratch GIT_INDEX_FILE.
 */
export async function computeTreeHash(worktreePath: string): Promise<string> {
  const scratchIndex = join(tmpdir(), `conclave-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
  try {
    await git(["add", "-A"], worktreePath, env);
    const tree = await git(["write-tree"], worktreePath, env);
    return tree.trim();
  } finally {
    await rm(scratchIndex, { force: true });
  }
}

/** Diffs the base commit against a captured tree hash, covering the full change-set. */
export async function computeDiff(worktreePath: string, baseCommit: string, finalTreeHash: string): Promise<string> {
  return git(["diff", "--no-color", baseCommit, finalTreeHash], worktreePath);
}

/** Thrown when a resumed session's recorded worktree is missing, or no longer on its recorded branch. */
export class WorktreeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeMismatchError";
  }
}

/** Validates that a previously-created worktree still exists on disk and is still on its recorded branch. */
export async function assertResumableWorktree(handle: Pick<WorktreeHandle, "path" | "branch">): Promise<void> {
  let inside: string;
  try {
    inside = await git(["rev-parse", "--is-inside-work-tree"], handle.path);
  } catch (error) {
    throw new WorktreeMismatchError(
      `worktree at ${handle.path} no longer exists or is not a Git working tree: ${(error as Error).message}`,
    );
  }
  if (inside.trim() !== "true") {
    throw new WorktreeMismatchError(`${handle.path} is not a Git working tree`);
  }
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], handle.path)).trim();
  if (branch !== handle.branch) {
    throw new WorktreeMismatchError(`worktree at ${handle.path} is on branch "${branch}", expected "${handle.branch}"`);
  }
}

/**
 * Every file a reader of the worktree would see: tracked files plus untracked ones git does not
 * ignore. This is the repository view handed to seats that cannot list files themselves.
 */
export async function listWorktreeFiles(worktreePath: string): Promise<string[]> {
  const output = await git(["ls-files", "--cached", "--others", "--exclude-standard"], worktreePath);
  return output.split("\n").filter((line) => line.length > 0);
}

/**
 * Removes a preserved worktree that is no longer wanted (retention pruning). Tries git first so the
 * source repository's worktree bookkeeping stays consistent, and falls back to deleting the
 * directory when the source repository itself is gone. The session branch is deleted only when it
 * still points at the base commit — i.e. it holds no commit of its own, so nothing is lost.
 */
export async function pruneWorktree(handle: WorktreeHandle): Promise<{ branchDeleted: boolean }> {
  try {
    await git(["worktree", "remove", "--force", handle.path], handle.sourceCwd);
  } catch {
    await rm(handle.path, { recursive: true, force: true });
  }
  let branchDeleted = false;
  try {
    await git(["worktree", "prune"], handle.sourceCwd);
    const tip = (await git(["rev-parse", "--verify", `refs/heads/${handle.branch}`], handle.sourceCwd)).trim();
    if (tip === handle.baseCommit) {
      await git(["branch", "-D", handle.branch], handle.sourceCwd);
      branchDeleted = true;
    }
  } catch {
    // Source repository or branch already gone: nothing further to clean up.
  }
  return { branchDeleted };
}

/**
 * Commits everything in the worktree to its branch under a self-contained identity (so this
 * doesn't depend on the host having git user.name/user.email configured), then removes the
 * temporary worktree directory. The branch itself is left in the source repository's refs —
 * this never merges, pushes, deletes the branch, or touches the source checkout.
 */
export async function commitAndRemoveWorktree(handle: WorktreeHandle, message: string): Promise<void> {
  const identity = ["-c", "user.name=Conclave", "-c", "user.email=conclave@local"];
  await git([...identity, "add", "-A"], handle.path);
  await git([...identity, "commit", "--allow-empty", "-m", message], handle.path);
  await git(["worktree", "remove", handle.path, "--force"], handle.sourceCwd);
}
