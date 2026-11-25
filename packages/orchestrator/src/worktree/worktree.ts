import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  // A branch named plain "conclave" makes every "conclave/<id>" ref impossible (a ref cannot be both
  // a branch and a directory of branches); fall back to a flat name in that repository.
  const flat = await git(["rev-parse", "--verify", "--quiet", "refs/heads/conclave"], sourceCwd).then(() => true, () => false);
  const branch = flat ? `conclave-${sessionId}` : `conclave/${sessionId}`;
  await git(["worktree", "add", "-b", branch, path, baseCommit], sourceCwd);
  return { path, branch, baseCommit, sourceCwd };
}

/** Diff flags that make output independent of the user's git config (noprefix, color, diff drivers). */
const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/** Thrown when a repository or folder holds a symlink that points outside it. */
export class UnsafeSymlinkError extends Error {}

/**
 * Symlinks in a commit that point outside its tree (absolute, or climbing out with `..`). A seat
 * editing the worktree would write through them into the real files — outside the isolation, and
 * invisible in the diff the council reviews.
 */
export async function escapingSymlinks(repository: string, commit: string): Promise<string[]> {
  const listing = await git(["ls-tree", "-r", "-z", "--full-tree", commit], repository);
  const escaping: string[] = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match = /^120000 blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const target = await git(["cat-file", "blob", match[1]!], repository);
    const inside = resolve("/root", dirname(match[2]!), target);
    if (isAbsolute(target) || !inside.startsWith(`/root${sep}`)) escaping.push(`${match[2]} -> ${target}`);
  }
  return escaping;
}

/**
 * Computes a full tree hash of the worktree's current working state — including untracked,
 * gitignore-respecting files — without touching the real index, via a scratch GIT_INDEX_FILE.
 */
export async function computeTreeHash(worktreePath: string): Promise<string> {
  const scratchIndex = join(tmpdir(), `conclave-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
  try {
    // Start from HEAD's tree, as the real index would: a file that is tracked but matches .gitignore
    // is still part of the tree, and must not show up as deleted.
    await git(["read-tree", "HEAD"], worktreePath, env);
    await git(["add", "-A"], worktreePath, env);
    const tree = await git(["write-tree"], worktreePath, env);
    return tree.trim();
  } finally {
    await rm(scratchIndex, { force: true });
  }
}

/** Diffs the base commit against a captured tree hash, covering the full change-set. */
export async function computeDiff(worktreePath: string, baseCommit: string, finalTreeHash: string): Promise<string> {
  return git(["diff", ...PLAIN_DIFF, baseCommit, finalTreeHash], worktreePath);
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

export interface RepositoryInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  /** The repository's top level, when `path` is inside one (possibly a subdirectory). */
  root?: string;
  branch?: string;
  head?: string;
  /** Uncommitted changes, ignoring Conclave's own `.conclave/` directory. */
  changes?: number;
  /**
   * Whether the council runs on the repository (a worktree of it) rather than a snapshot of this
   * folder: the repository has a commit, and this folder is its root or holds files it tracks. A
   * folder that is untracked or ignored inside some parent repository (a project under a
   * dotfiles-managed home, say) is not that repository's content and is snapshotted instead.
   */
  useRepository?: boolean;
}

/**
 * What a folder is, for choosing where to run a council: does it exist, is it (inside) a git
 * repository, which one, and is the checkout clean — the same cleanliness rule the run enforces.
 */
export async function inspectRepository(path: string): Promise<RepositoryInfo> {
  const info: RepositoryInfo = { path, exists: false, isDirectory: false, isGitRepo: false };
  try {
    const stats = await stat(path);
    info.exists = true;
    info.isDirectory = stats.isDirectory();
  } catch {
    return info;
  }
  if (!info.isDirectory) return info;
  try {
    info.root = (await git(["rev-parse", "--show-toplevel"], path)).trim();
    info.isGitRepo = true;
  } catch {
    return info;
  }
  try {
    info.branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], info.root)).trim();
    info.head = (await git(["rev-parse", "--short", "HEAD"], info.root)).trim();
  } catch {
    // A repository with no commits yet has no HEAD; the run will refuse it with its own message.
  }
  const status = await git(["status", "--porcelain", "--", ".", ":(exclude).conclave"], info.root);
  info.changes = status.split("\n").filter((line) => line.trim().length > 0).length;
  info.useRepository = Boolean(info.head) && (await belongsToRepository(path, info.root));
  return info;
}

/**
 * Whether a folder inside a repository's work tree is that repository's content: its root, a folder
 * holding tracked files, or an empty folder in it. A folder the repository ignores, or whose files
 * it does not track at all (a project under a dotfiles-managed home, typically with untracked files
 * hidden from `git status`), is not — running on the repository would never show the council its files.
 */
async function belongsToRepository(path: string, root: string): Promise<boolean> {
  if ((await realpathOrSelf(path)) === (await realpathOrSelf(root))) return true;
  const has = (args: string[]) => git(args, path).then((out) => out.length > 0, () => false);
  if (await has(["ls-files", "-z", "--", "."])) return true;
  if (await git(["check-ignore", "-q", "."], path).then(() => true, () => false)) return false;
  return !(await has(["ls-files", "-z", "--others", "--", "."]));
}

const realpathOrSelf = (path: string): Promise<string> => realpath(path).catch(() => path);

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

/** Where private snapshot repositories of plain folders live. */
export const snapshotRoot = () => process.env.CONCLAVE_SNAPSHOT_DIR ?? join(homedir(), ".conclave", "snapshots");

/**
 * Generated and bulky content left out of a folder's snapshot even without a .gitignore — the same
 * things a sensible .gitignore would exclude. The folder's own .gitignore files apply on top.
 */
const SNAPSHOT_EXCLUDES = [".conclave/", "node_modules/", ".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".tox/", ".DS_Store"];

/** Beyond this, a folder is almost certainly full of generated files a snapshot should not copy. */
const MAX_SNAPSHOT_FILES = 50_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;

export class SnapshotTooLargeError extends Error {}

const SNAPSHOT_IDENTITY = ["-c", "user.name=Conclave", "-c", "user.email=conclave@local"];

/**
 * A private git repository holding one commit: the folder exactly as it is now. It is built by
 * pointing git's work tree at the folder, so the folder itself is only read — no `.git` is created
 * in it and nothing in it changes. The session then runs in an ordinary worktree of this
 * repository, with the same isolation, diffing, and commit machinery as a real git repository.
 */
export async function createSnapshotRepository(folder: string, sessionId: string): Promise<{ repository: string; baseCommit: string; fileCount: number }> {
  const repository = join(snapshotRoot(), sessionId);
  await mkdir(repository, { recursive: true });
  try {
    await git(["init", "-q", "-b", "snapshot"], repository);
    await writeFile(join(repository, ".git", "info", "exclude"), `${SNAPSHOT_EXCLUDES.join("\n")}\n`);
    const outer = ["--git-dir", join(repository, ".git"), "--work-tree", folder];
    // Counted and sized before anything is copied into the snapshot, so an oversized folder is
    // refused in seconds rather than after hashing all of it.
    const candidates = (await git([...outer, "ls-files", "-z", "--others", "--exclude-standard"], repository)).split("\0").filter(Boolean);
    if (candidates.length > MAX_SNAPSHOT_FILES) {
      throw new SnapshotTooLargeError(`${folder} has ${candidates.length} files, too many to snapshot; add a .gitignore that excludes generated files, or run Conclave on a git repository`);
    }
    // Another repository inside the folder would be stored as a bare reference to it: the council
    // would see an empty directory there, and its edits inside it would be silently dropped.
    // (`ls-files --others` lists an untracked repository as one entry ending in "/".)
    const nested = candidates.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1));
    let bytes = 0;
    for (const path of candidates) {
      const info = await lstat(join(folder, path)).catch(() => undefined);
      bytes += info?.isFile() ? info.size : 0;
    }
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new SnapshotTooLargeError(`${folder} holds ${(bytes / 1024 ** 3).toFixed(1)} GB, too much to snapshot; add a .gitignore that excludes large or generated files, or run Conclave on a git repository`);
    }
    if (nested.length) throw new NestedRepositoryError(nestedMessage(folder, nested));
    try {
      await git([...outer, "add", "-A"], repository);
    } catch (error) {
      // A nested repository with no commit yet makes `add` itself fail.
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      const bare = /'([^']+)\/' does not have a commit checked out/.exec(stderr);
      if (bare) throw new NestedRepositoryError(nestedMessage(folder, [bare[1]!]));
      throw error;
    }
    const gitlinks = (await git([...outer, "ls-files", "-s", "-z"], repository)).split("\0").filter((entry) => entry.startsWith("160000 ")).map((entry) => entry.split("\t").slice(1).join("\t"));
    if (gitlinks.length) throw new NestedRepositoryError(nestedMessage(folder, gitlinks));
    const fileCount = (await git([...outer, "ls-files", "-z"], repository)).split("\0").filter(Boolean).length;
    // Never the user's hooks or signing setup: this is Conclave's private bookkeeping commit.
    await git([...SNAPSHOT_IDENTITY, "-c", "commit.gpgsign=false", ...outer, "commit", "-q", "--no-verify", "--allow-empty", "-m", `Snapshot of ${folder}`], repository);
    const baseCommit = (await git(["rev-parse", "HEAD"], repository)).trim();
    return { repository, baseCommit, fileCount };
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}

/** A plain folder that contains other git repositories, which a snapshot cannot represent. */
export class NestedRepositoryError extends Error {}

const nestedMessage = (folder: string, nested: string[]) =>
  `${folder} contains other git repositories (${nested.slice(0, 5).join(", ")}${nested.length > 5 ? ", …" : ""}). ` +
  "A snapshot cannot include them, so the council would not see their files. Run Conclave on each repository instead.";

export interface AppliedChange {
  path: string;
  change: "added" | "modified" | "deleted";
}

export class ApplyConflictError extends Error {}

/** Writing the changes failed partway (a read-only file, a full disk); every file was put back. */
export class ApplyFailedError extends Error {}

/**
 * Writes a ratified snapshot session's changes into the plain folder it was run against. The patch
 * is exactly base-commit → ratified branch, applied with context checking: if the folder was edited
 * since the snapshot in a way that overlaps the changes, nothing is written and the conflict is
 * reported. `check` only verifies. Returns the files changed.
 */
export async function applySnapshotChanges(input: { repository: string; baseCommit: string; branch: string; target: string; check?: boolean }): Promise<AppliedChange[]> {
  const { repository, baseCommit, branch, target } = input;
  // NUL-separated and unquoted, so names with spaces, tabs or non-ASCII characters come back verbatim.
  const statuses = (await git(["-c", "core.quotePath=false", "diff", "--name-status", "-z", "--no-renames", baseCommit, branch], repository)).split("\0");
  const files: AppliedChange[] = [];
  for (let index = 0; index + 1 < statuses.length; index += 2) {
    const status = statuses[index]!;
    files.push({ path: statuses[index + 1]!, change: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
  }
  if (files.length === 0) return [];
  // The patch's format is pinned (prefixes, no color, no external diff drivers) whatever the user's
  // git config says, so `apply -p1` reads it back exactly.
  const patch = await git(["diff", "--binary", "--full-index", "--no-renames", ...PLAIN_DIFF, baseCommit, branch], repository);
  // The snapshot repository as git dir and the folder as work tree, run from inside the folder:
  // `git apply` resolves paths against the directory it runs in. Without --index, nothing but the
  // folder's own files is touched.
  const outer = ["--git-dir", join(repository, ".git"), "--work-tree", target];
  const apply = [...outer, "apply", "-p1", "--whitespace=nowarn"];
  try {
    await gitWithInput([...apply, "--check", "-"], target, patch);
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? error).trim().split("\n").slice(0, 8).join("\n");
    throw new ApplyConflictError(`the folder changed since the council's snapshot, so its changes no longer apply cleanly:\n${detail}`);
  }
  if (input.check) return files;
  // `git apply` writes file by file; if one write fails (a read-only file, a full disk) the ones
  // before it are already changed. Keep a copy of everything it will touch, and put it all back.
  const backup = await mkdtemp(join(tmpdir(), "conclave-apply-"));
  try {
    const saved: Array<{ path: string; mode: number }> = [];
    for (const file of files) {
      const info = await lstat(join(target, file.path)).catch(() => undefined);
      if (!info?.isFile()) continue;
      await mkdir(dirname(join(backup, file.path)), { recursive: true });
      await copyFile(join(target, file.path), join(backup, file.path));
      saved.push({ path: file.path, mode: info.mode });
    }
    try {
      await gitWithInput([...apply, "-"], target, patch);
    } catch (error) {
      for (const file of files) if (file.change === "added") await rm(join(target, file.path), { force: true }).catch(() => undefined);
      for (const { path, mode } of saved) {
        await mkdir(dirname(join(target, path)), { recursive: true }).catch(() => undefined);
        await copyFile(join(backup, path), join(target, path)).catch(() => undefined);
        await chmod(join(target, path), mode & 0o7777).catch(() => undefined);
      }
      const detail = String((error as { stderr?: string }).stderr ?? error).trim().split("\n").slice(0, 4).join("\n");
      throw new ApplyFailedError(`writing the changes failed partway, so every file was put back as it was and nothing was applied:\n${detail}`);
    }
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
  return files;
}

function gitWithInput(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
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
  // The council already ratified this work: the repository's own commit hooks (commitlint, lint-staged)
  // and signing setup must not turn a unanimous approval into an error at the very last step.
  await git([...identity, "-c", "commit.gpgsign=false", "commit", "--no-verify", "--allow-empty", "-m", message], handle.path);
  await git(["worktree", "remove", handle.path, "--force"], handle.sourceCwd);
}
