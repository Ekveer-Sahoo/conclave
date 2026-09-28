import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DirtySourceRepositoryError,
  InvalidRepositoryError,
  assertCleanRepository,
  assertValidRepository,
  commitAndRemoveWorktree,
  computeDiff,
  computeTreeHash,
  createWorktree,
} from "../../src/worktree/worktree.ts";

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(dir: string): Promise<string> {
  await git(["init", "-q"], dir);
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(["add", "-A"], dir);
  await git(["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "init"], dir);
  return (await git(["rev-parse", "HEAD"], dir)).trim();
}

const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("assertValidRepository rejects a non-git directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-notgit-"));
  await assert.rejects(() => assertValidRepository(dir), InvalidRepositoryError);
});

test("assertValidRepository returns HEAD sha for a valid repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-valid-"));
  const head = await initRepo(dir);
  const sha = await assertValidRepository(dir);
  assert.equal(sha, head);
});

test("assertCleanRepository accepts a clean repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-clean-"));
  await initRepo(dir);
  await assert.doesNotReject(() => assertCleanRepository(dir));
});

test("assertCleanRepository rejects a repository with untracked changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-dirty-"));
  await initRepo(dir);
  await writeFile(join(dir, "scratch.txt"), "uncommitted\n");
  await assert.rejects(() => assertCleanRepository(dir), DirtySourceRepositoryError);
});

test("assertCleanRepository rejects a repository with modified tracked files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-dirty-tracked-"));
  await initRepo(dir);
  await writeFile(join(dir, "README.md"), "changed\n");
  await assert.rejects(() => assertCleanRepository(dir), DirtySourceRepositoryError);
});

test("createWorktree creates an isolated worktree outside the source repository, and changes there never touch the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-isolate-"));
  const head = await initRepo(dir);
  const sessionId = uniqueId();
  const handle = await createWorktree(dir, sessionId, head);
  try {
    assert.ok(!handle.path.startsWith(dir), "worktree path must live outside the source repository");
    assert.equal(handle.baseCommit, head);
    assert.match(handle.branch, /^conclave\//);

    await writeFile(join(handle.path, "new-file.txt"), "from the worktree\n");
    await assert.doesNotReject(() => stat(join(handle.path, "new-file.txt")));
    await assert.rejects(() => stat(join(dir, "new-file.txt")));

    const sourceStatus = await git(["status", "--porcelain"], dir);
    assert.equal(sourceStatus.trim(), "", "source repository working tree must remain untouched");
  } finally {
    await git(["worktree", "remove", handle.path, "--force"], dir).catch(() => {});
  }
});

test("computeTreeHash captures untracked files without mutating the real index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-hash-"));
  const head = await initRepo(dir);
  const sessionId = uniqueId();
  const handle = await createWorktree(dir, sessionId, head);
  try {
    const beforeHash = await computeTreeHash(handle.path);
    await writeFile(join(handle.path, "added.txt"), "content\n");
    const afterHash = await computeTreeHash(handle.path);
    assert.notEqual(beforeHash, afterHash);

    const statusAfterHash = await git(["status", "--porcelain"], handle.path);
    assert.match(statusAfterHash, /added\.txt/, "computeTreeHash must not stage the file into the real index");
  } finally {
    await git(["worktree", "remove", handle.path, "--force"], dir).catch(() => {});
  }
});

test("computeDiff reports changes made in the worktree, including new files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-diff-"));
  const head = await initRepo(dir);
  const sessionId = uniqueId();
  const handle = await createWorktree(dir, sessionId, head);
  try {
    await writeFile(join(handle.path, "README.md"), "changed content\n");
    await writeFile(join(handle.path, "brand-new.txt"), "new\n");
    const finalHash = await computeTreeHash(handle.path);
    const diff = await computeDiff(handle.path, handle.baseCommit, finalHash);
    assert.match(diff, /README\.md/);
    assert.match(diff, /brand-new\.txt/);
    assert.match(diff, /changed content/);
  } finally {
    await git(["worktree", "remove", handle.path, "--force"], dir).catch(() => {});
  }
});

test("commitAndRemoveWorktree commits the branch, removes the worktree directory, and never mutates the source checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-success-"));
  const head = await initRepo(dir);
  const sessionId = uniqueId();
  const handle = await createWorktree(dir, sessionId, head);
  await writeFile(join(handle.path, "committed.txt"), "shipped\n");

  await commitAndRemoveWorktree(handle, "Conclave: test task");

  await assert.rejects(() => stat(handle.path), "worktree directory must be removed after success");

  const branchesOut = await git(["branch", "--list", handle.branch], dir);
  assert.match(branchesOut, new RegExp(handle.branch.replace(/\//g, "\\/")), "branch must be preserved");

  const sourceHead = (await git(["rev-parse", "HEAD"], dir)).trim();
  assert.equal(sourceHead, head, "source checkout HEAD must never move");
  const sourceStatus = await git(["status", "--porcelain"], dir);
  assert.equal(sourceStatus.trim(), "", "source checkout must remain untouched");

  const branchLog = await git(["show", `${handle.branch}:committed.txt`], dir);
  assert.equal(branchLog, "shipped\n");
});

test("failure path (no cleanup call) leaves the worktree on disk with its changes intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-wt-fail-"));
  const head = await initRepo(dir);
  const sessionId = uniqueId();
  const handle = await createWorktree(dir, sessionId, head);
  await writeFile(join(handle.path, "unreviewed.txt"), "still here\n");

  // Simulate an inconclusive audit / crash: nothing calls commitAndRemoveWorktree.
  const contents = await readFile(join(handle.path, "unreviewed.txt"), "utf8");
  assert.equal(contents, "still here\n");
  const status = await git(["status", "--porcelain"], handle.path);
  assert.match(status, /unreviewed\.txt/);

  await git(["worktree", "remove", handle.path, "--force"], dir).catch(() => {});
});
