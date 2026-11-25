import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import {
  ApplyFailedError,
  NestedRepositoryError,
  applySnapshotChanges,
  computeDiff,
  computeTreeHash,
  createSnapshotRepository,
  createWorktree,
  escapingSymlinks,
  inspectRepository,
} from "../../src/worktree/worktree.ts";

// Regression tests for defects found by the multi-agent bug hunt. Each one failed before its fix.

const execFileAsync = promisify(execFile);
const git = async (args: string[], cwd: string) => (await execFileAsync("git", args, { cwd })).stdout;
const identity = ["-c", "user.name=T", "-c", "user.email=t@l"];
const uniqueId = () => `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let previousSnapshotDir: string | undefined;
before(async () => {
  previousSnapshotDir = process.env.CONCLAVE_SNAPSHOT_DIR;
  process.env.CONCLAVE_SNAPSHOT_DIR = await mkdtemp(join(tmpdir(), "conclave-reg-snapshots-"));
});
after(() => {
  if (previousSnapshotDir === undefined) delete process.env.CONCLAVE_SNAPSHOT_DIR;
  else process.env.CONCLAVE_SNAPSHOT_DIR = previousSnapshotDir;
});

/** A plain folder, its snapshot, and a ratified branch that makes `edit` to it. */
async function ratifiedSnapshot(files: Record<string, string>, edit: (worktree: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "conclave-reg-plain-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), content);
  }
  const id = uniqueId();
  const { repository, baseCommit } = await createSnapshotRepository(folder, id);
  const worktree = await createWorktree(repository, id, baseCommit);
  await edit(worktree.path);
  await git([...identity, "add", "-A"], worktree.path);
  await git([...identity, "commit", "-q", "-m", "ratified"], worktree.path);
  return { folder, handle: { repository, baseCommit, branch: worktree.branch, target: folder } };
}

test("apply writes the right files whatever the user's git config says about diffs", async () => {
  const { folder, handle } = await ratifiedSnapshot({ "src/config.js": "debug = true;\n" }, (w) => writeFile(join(w, "src/config.js"), "debug = false;\n"));
  const gitconfig = join(await mkdtemp(join(tmpdir(), "conclave-reg-gitconfig-")), "config");
  await writeFile(gitconfig, "[diff]\n\tnoprefix = true\n[color]\n\tui = always\n\tdiff = always\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  try {
    await applySnapshotChanges(handle);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  assert.equal(await readFile(join(folder, "src/config.js"), "utf8"), "debug = false;\n");
  await assert.rejects(() => stat(join(folder, "config.js")), "nothing lands one directory off");
});

test("apply reports file names verbatim, spaces and non-ASCII included", async () => {
  const { handle } = await ratifiedSnapshot({ "a.txt": "a\n" }, (w) => writeFile(join(w, "héllo wörld.txt"), "hi\n"));
  const files = await applySnapshotChanges({ ...handle, check: true });
  assert.deepEqual(files, [{ path: "héllo wörld.txt", change: "added" }]);
});

test("an apply that fails partway puts every file back", async () => {
  const { folder, handle } = await ratifiedSnapshot({ "a.txt": "one\n", "locked/keep.txt": "k\n" }, async (w) => {
    await writeFile(join(w, "a.txt"), "ONE\n");
    await writeFile(join(w, "locked/new.txt"), "new\n");
  });
  await chmod(join(folder, "locked"), 0o555);
  try {
    await assert.rejects(() => applySnapshotChanges(handle), ApplyFailedError);
    assert.equal(await readFile(join(folder, "a.txt"), "utf8"), "one\n", "the file written before the failure is restored");
  } finally {
    await chmod(join(folder, "locked"), 0o755);
  }
  await applySnapshotChanges(handle);
  assert.equal(await readFile(join(folder, "a.txt"), "utf8"), "ONE\n", "once the folder is writable, the same apply succeeds");
});

test("a plain folder holding another git repository is refused with a clear message, and no snapshot is left behind", async () => {
  const folder = await mkdtemp(join(tmpdir(), "conclave-reg-nested-"));
  await writeFile(join(folder, "notes.md"), "n\n");
  await mkdir(join(folder, "lib"));
  await git(["init", "-q"], join(folder, "lib"));
  await writeFile(join(folder, "lib", "util.js"), "x\n");
  await git(["add", "-A"], join(folder, "lib"));
  await git([...identity, "commit", "-q", "-m", "i"], join(folder, "lib"));
  const id = uniqueId();
  await assert.rejects(() => createSnapshotRepository(folder, id), (error: unknown) => error instanceof NestedRepositoryError && /lib/.test(error.message));
  await assert.rejects(() => stat(join(process.env.CONCLAVE_SNAPSHOT_DIR!, id)), "the partial snapshot was removed");

  const empty = await mkdtemp(join(tmpdir(), "conclave-reg-nested-empty-"));
  await mkdir(join(empty, "tool"));
  await git(["init", "-q"], join(empty, "tool"));
  await writeFile(join(empty, "tool", "a.js"), "a\n");
  await assert.rejects(() => createSnapshotRepository(empty, uniqueId()), NestedRepositoryError, "a nested repository with no commit yet too");
});

test("symlinks that point outside the tree are found", async () => {
  const repo = await mkdtemp(join(tmpdir(), "conclave-reg-links-"));
  await git(["init", "-q"], repo);
  await writeFile(join(repo, "real.json"), "{}\n");
  await symlink("real.json", join(repo, "inside.json"));
  await symlink("/etc/hosts", join(repo, "absolute"));
  await mkdir(join(repo, "sub"));
  await symlink("../../outside", join(repo, "sub", "climbing"));
  await git(["add", "-A"], repo);
  await git([...identity, "commit", "-q", "-m", "i"], repo);
  const found = await escapingSymlinks(repo, "HEAD");
  assert.deepEqual(found.sort(), ["absolute -> /etc/hosts", "sub/climbing -> ../../outside"]);
});

test("a tracked file that matches .gitignore is not reported as deleted in the review diff", async () => {
  const repo = await mkdtemp(join(tmpdir(), "conclave-reg-ignored-"));
  await git(["init", "-q"], repo);
  await writeFile(join(repo, ".gitignore"), "*.env\n");
  await writeFile(join(repo, "example.env"), "KEY=\n");
  await git(["add", "-f", ".gitignore", "example.env"], repo);
  await git([...identity, "commit", "-q", "-m", "i"], repo);
  const base = (await git(["rev-parse", "HEAD"], repo)).trim();
  const worktree = await createWorktree(repo, uniqueId(), base);
  try {
    assert.equal(await computeDiff(worktree.path, base, await computeTreeHash(worktree.path)), "");
  } finally {
    await git(["worktree", "remove", "--force", worktree.path], repo).catch(() => undefined);
  }
});

test("a repository that already has a branch named conclave can still run councils", async () => {
  const repo = await mkdtemp(join(tmpdir(), "conclave-reg-branch-"));
  await git(["init", "-q"], repo);
  await git([...identity, "commit", "-q", "--allow-empty", "-m", "i"], repo);
  await git(["branch", "conclave"], repo);
  const id = uniqueId();
  const worktree = await createWorktree(repo, id, (await git(["rev-parse", "HEAD"], repo)).trim());
  try {
    assert.equal(worktree.branch, `conclave-${id}`);
  } finally {
    await git(["worktree", "remove", "--force", worktree.path], repo).catch(() => undefined);
  }
});

test("a folder a parent repository neither tracks nor contains is run as a snapshot, not as that repository", async () => {
  const home = await mkdtemp(join(tmpdir(), "conclave-reg-parent-"));
  await git(["init", "-q"], home);
  await writeFile(join(home, ".bashrc"), "x\n");
  await writeFile(join(home, ".gitignore"), "projects/\n");
  await git(["add", "-A"], home);
  await git([...identity, "commit", "-q", "-m", "dotfiles"], home);
  await mkdir(join(home, "projects", "myapp"), { recursive: true });
  await writeFile(join(home, "projects", "myapp", "app.js"), "app\n");
  const inside = await inspectRepository(join(home, "projects", "myapp"));
  assert.equal(inside.isGitRepo, true);
  assert.equal(inside.useRepository, false);
  const root = await inspectRepository(home);
  assert.equal(root.useRepository, true, "the repository itself still runs as a repository");
  await rm(join(home, "projects"), { recursive: true, force: true });
});
