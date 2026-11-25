import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach } from "node:test";
import { promisify } from "node:util";
import type { SeatConfig } from "@conclave/core";
import { getSessionStatus, resumeCouncil, runCouncil } from "../../dist/session/autonomousCouncil.js";
import { pruneSessions } from "../../dist/session/prune.js";
import { clearFakeSeats, registerFakeSeat } from "../../dist/seats/fakeAdapter.js";

const execFileAsync = promisify(execFile);

async function setupRepo(prefix: string): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), `conclave-${prefix}-`));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  const scratch = await mkdtemp(join(tmpdir(), `conclave-${prefix}-db-`));
  return { dir, dbPath: join(scratch, "events.db") };
}

const fakeSeat = (id: string): SeatConfig => ({
  id, label: id, adapter: "fake", role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 5_000, enabled: true, tier: "standard",
});
const council = () => ["claude", "codex"].map(fakeSeat);

/** A session the council declines on its first audit: its worktree is kept for inspection. */
async function unratifiedSession(dir: string, dbPath: string): Promise<string> {
  registerFakeSeat("codex", ({ prompt }) =>
    prompt.includes("Audit the implementation plan")
      ? { kind: "verdict", verdict: { overall_verdict: "APPROVE_WITH_CHANGES", verdict_reasoning: "not yet" } }
      : { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok" } },
  );
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), discussionRoundCap: 1 });
  assert.equal(result.approved, false);
  return result.sessionId;
}

const branchExists = async (dir: string, branch: string) =>
  (await execFileAsync("git", ["branch", "--list", branch], { cwd: dir })).stdout.trim().length > 0;

afterEach(() => clearFakeSeats());

test("prune removes an old unratified session's worktree and empty branch, records it, and leaves the log intact", async () => {
  const { dir, dbPath } = await setupRepo("prune");
  const sessionId = await unratifiedSession(dir, dbPath);
  const before = getSessionStatus(dbPath, sessionId);
  const worktreePath = before.worktree!.path;
  const branch = before.worktree!.branch;
  assert.ok(existsSync(worktreePath));

  const later = Date.now() + 60_000;
  assert.equal((await pruneSessions({ dbPath, olderThanMs: 3_600_000, now: later })).pruned.length, 0, "a session newer than the threshold is left alone");

  const dry = await pruneSessions({ dbPath, olderThanMs: 0, now: later, dryRun: true });
  assert.deepEqual(dry.pruned.map((item) => item.sessionId), [sessionId]);
  assert.equal(dry.pruned[0].state, "not_approved");
  assert.ok(existsSync(worktreePath), "a dry run changes nothing");

  const real = await pruneSessions({ dbPath, olderThanMs: 0, now: later });
  assert.deepEqual(real.pruned.map((item) => item.sessionId), [sessionId]);
  assert.equal(real.pruned[0].branchDeleted, true, "the session branch held no commit of its own, so it is deleted too");
  assert.equal(existsSync(worktreePath), false);
  assert.equal(await branchExists(dir, branch), false);
  const worktrees = (await execFileAsync("git", ["worktree", "list"], { cwd: dir })).stdout;
  assert.ok(!worktrees.includes(worktreePath), "git's own worktree bookkeeping is cleaned up");

  const after = getSessionStatus(dbPath, sessionId);
  assert.match(after.worktreeRemoved?.reason ?? "", /pruned/);
  assert.equal(after.outcome, "NOT_APPROVED", "history is kept: the session still reports how it ended");
  assert.equal((await pruneSessions({ dbPath, olderThanMs: 0, now: later })).pruned.length, 0, "pruning is idempotent");
  await assert.rejects(() => resumeCouncil({ sessionId, dbPath }), /worktree was removed/);
});

test("prune never touches a ratified session's branch, nor a session another process is running", async () => {
  const { dir, dbPath } = await setupRepo("prune-keep");
  const ratified = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  assert.equal(ratified.approved, true);
  const ratifiedBranch = getSessionStatus(dbPath, ratified.sessionId).worktree!.branch;

  const running = await unratifiedSession(dir, dbPath);
  // Simulate a live process holding the session's lock.
  const lock = join(dirname(dbPath), ".locks", `${running}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, String(process.pid));

  const result = await pruneSessions({ dbPath, olderThanMs: 0, now: Date.now() + 60_000 });
  assert.equal(result.pruned.length, 0);
  assert.deepEqual(result.skipped.map((item) => item.sessionId), [running]);
  assert.ok(existsSync(getSessionStatus(dbPath, running).worktree!.path));
  assert.equal(await branchExists(dir, ratifiedBranch), true, "the branch holding ratified work is the session's output and is never pruned");
});

test("a pruned session that was cancelled is reported as pruned on resume, not as 'completed successfully'", async () => {
  const { dir, dbPath } = await setupRepo("prune-cancelled");
  const controller = new AbortController();
  registerFakeSeat("claude", ({ prompt }) => {
    if (!prompt.includes("concrete implementation plan")) return { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok" } };
    controller.abort(new Error("stopped"));
    return { kind: "hang" };
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), signal: controller.signal });
  assert.equal(getSessionStatus(dbPath, result.sessionId).cancelled, true);
  await pruneSessions({ dbPath, olderThanMs: 0, now: Date.now() + 60_000 });
  await assert.rejects(() => resumeCouncil({ sessionId: result.sessionId, dbPath }), /worktree was removed/);
});
