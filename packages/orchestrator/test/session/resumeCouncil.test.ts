import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { SeatConfig } from "@conclave/core";
import { getSessionStatus, resumeCouncil, runCouncil } from "../../dist/session/autonomousCouncil.js";
import { EventStore } from "../../src/store/eventStore.ts";

const execFileAsync = promisify(execFile);
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
}

const seatCfg = (id: string, cliArgsTemplate: string[]): SeatConfig => ({
  id,
  label: id,
  adapter: "cli",
  cliCommand: process.execPath,
  cliArgsTemplate,
  role: "CORRECTNESS",
  temperature: 0.2,
  maxTokens: 100,
  timeoutMs: 3_000,
  enabled: true,
  tier: "standard",
});

interface RawEvent { type: string; payload: unknown }

// A fixed-ms setTimeout before aborting a run is inherently flaky under load: when the whole test
// suite runs in parallel, worktree setup (git subprocess) and the first CLI seat spawn can easily
// take longer than a few hundred ms, so the abort can fire before the phase under test has even
// started, silently changing what the test is exercising. Poll the durable event log itself for
// the phase actually starting instead — deterministic regardless of system load, with a generous
// ceiling so a genuinely stuck run still fails loudly rather than hanging forever.
async function waitForSessionEvent(dbPath: string, predicate: (event: RawEvent) => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const store = new EventStore(dbPath);
      try {
        const [sessionId] = store.listSessions(1, 0);
        if (sessionId && (store.replay(sessionId) as RawEvent[]).some(predicate)) return;
      } finally {
        store.close();
      }
    } catch {
      // dbPath's file may not exist yet, or may be mid-write from another connection — retry.
    }
    if (Date.now() >= deadline) throw new Error("waitForSessionEvent: timed out waiting for a matching event");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Aborts `controller` as soon as the (single) session in dbPath records an event matching `predicate`. */
function abortAfterEvent(dbPath: string, controller: AbortController, predicate: (event: RawEvent) => boolean, reason: string): void {
  void waitForSessionEvent(dbPath, predicate).then(
    () => controller.abort(new Error(reason)),
    (error) => controller.abort(error instanceof Error ? error : new Error(String(error))),
  );
}

// Same idea, but for a resumed run re-entering a round it already entered once before the crash —
// the first PhaseEntered for that round is still in the log, so "has any match" would fire
// instantly. Wait for the match COUNT to reach a target instead (e.g. 2 = "entered again on resume").
async function waitForSessionEventCount(dbPath: string, predicate: (event: RawEvent) => boolean, minCount: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const store = new EventStore(dbPath);
      try {
        const [sessionId] = store.listSessions(1, 0);
        const count = sessionId ? (store.replay(sessionId) as RawEvent[]).filter(predicate).length : 0;
        if (count >= minCount) return;
      } finally {
        store.close();
      }
    } catch {
      // dbPath's file may not exist yet, or may be mid-write from another connection — retry.
    }
    if (Date.now() >= deadline) throw new Error("waitForSessionEventCount: timed out waiting for match count");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function abortAfterEventCount(dbPath: string, controller: AbortController, predicate: (event: RawEvent) => boolean, minCount: number, reason: string): void {
  void waitForSessionEventCount(dbPath, predicate, minCount).then(
    () => controller.abort(new Error(reason)),
    (error) => controller.abort(error instanceof Error ? error : new Error(String(error))),
  );
}

const enteredRound0 = (event: RawEvent) =>
  event.type === "PhaseEntered" && (event.payload as { phase: string; round: number }).phase === "PLAN_AUDIT" && (event.payload as { round: number }).round === 0;
/** PLAN is the first phase that invokes a seat, so it is where a hanging provider first blocks. */
const enteredPlan = (event: RawEvent) =>
  event.type === "PhaseEntered" && (event.payload as { phase: string; round: number }).phase === "PLAN" && (event.payload as { round: number }).round === 0;
const enteredExecute = (event: RawEvent) => event.type === "PhaseEntered" && (event.payload as { phase: string }).phase === "EXECUTE";

test("resumes an interrupted discussion round and reaches consensus without a second worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-resume-discuss-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-discuss-scratch-"));
  const provider = join(scratch, "flaky.mjs");
  const marker = join(scratch, "marker");
  // Hangs forever on the FIRST plan audit only (simulating a crash mid-round), answering every
  // other call at once. Keying off the prompt rather than a bare call counter matters now that
  // PLAN runs before PLAN_AUDIT: a plain "hang on call 1" script would stall the wrong phase.
  await writeFile(
    provider,
    `
import { existsSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const prompt = process.argv[3] || "";
const marker = process.env.RESUME_TEST_MARKER;
if (prompt.includes("Audit the implementation plan") && !existsSync(marker)) {
  try { writeFileSync(marker, "1", { flag: "wx" }); } catch {}
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: { promptTokens: 1, completionTokens: 2 } }));
}
`,
  );
  const seats = [seatCfg("claude", [provider, "{seat}", "{prompt}"]), seatCfg("codex", [provider, "{seat}", "{prompt}"]), seatCfg("antigravity", [provider, "{seat}", "{prompt}"])].map(
    (seat) => ({ ...seat, cliArgsTemplate: [provider, seat.id, "{prompt}"] }),
  );
  const dbPath = join(scratch, "events.db");
  const env = { ...process.env, RESUME_TEST_MARKER: marker };
  const originalEnv = process.env.RESUME_TEST_MARKER;
  process.env.RESUME_TEST_MARKER = marker;
  try {
    const controller = new AbortController();
    // Abort only once a provider has actually begun hanging (it writes the marker first). Aborting
    // on PhaseEntered alone races the provider's own startup: if the abort lands before any
    // provider process runs, no marker exists, and the resumed audit hangs as if it were the first.
    void waitForSessionEvent(dbPath, enteredRound0).then(async () => {
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort(new Error("simulated crash"));
    });
    const first = await runCouncil({ task: "test", cwd: dir, dbPath, seats, signal: controller.signal });
    assert.equal(first.approved, false);

    const store1 = new EventStore(dbPath);
    const midEvents = store1.replay(first.sessionId);
    store1.close();
    assert.equal(midEvents.filter((e) => e.type !== "ActivityLogged").at(-1)?.type, "SessionCancelled");
    assert.equal(midEvents.filter((e) => e.type === "WorktreeCreated").length, 1);

    const activity: string[] = [];
    const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath, onActivity: (a) => activity.push(a.message) });
    assert.ok(activity[0].includes("PLAN_AUDIT round 1"), `expected resume to restart the interrupted plan audit, got: ${activity[0]}`);
    assert.equal(resumed.approved, true);

    const store2 = new EventStore(dbPath);
    const finalEvents = store2.replay(first.sessionId);
    store2.close();
    assert.equal(finalEvents.filter((e) => e.type === "WorktreeCreated").length, 1, "resume must never create a second worktree");
    assert.equal(finalEvents.filter((e) => e.type === "SessionResumed").length, 1);
    assert.deepEqual(finalEvents.filter((e) => e.type !== "ActivityLogged").slice(-2).map((e) => e.type), ["WorktreeRemoved", "SessionConcluded"]);
  } finally {
    if (originalEnv === undefined) delete process.env.RESUME_TEST_MARKER;
    else process.env.RESUME_TEST_MARKER = originalEnv;
  }
});

test("resumes an interrupted execution by auditing existing work instead of re-executing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-resume-execute-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-execute-scratch-"));
  const provider = join(scratch, "flaky-execute.mjs");
  const marker = join(scratch, "marker");
  await writeFile(
    provider,
    `
import { existsSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const prompt = process.argv[3] || "";
const isExecuteLike = prompt.includes("Implement this task completely") || prompt.includes("Repair and improve");
const marker = process.env.RESUME_TEST_MARKER;
if (isExecuteLike && !existsSync(marker)) {
  try { writeFileSync(marker, "1", { flag: "wx" }); } catch {}
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: { promptTokens: 1, completionTokens: 2 } }));
}
`,
  );
  const seats = ["claude", "codex", "antigravity"].map((id) => seatCfg(id, [provider, id, "{prompt}"]));
  const dbPath = join(scratch, "events.db");
  const originalEnv = process.env.RESUME_TEST_MARKER;
  process.env.RESUME_TEST_MARKER = marker;
  try {
    const controller = new AbortController();
    abortAfterEvent(dbPath, controller, enteredExecute, "simulated crash during execute");
    const first = await runCouncil({ task: "test", cwd: dir, dbPath, seats, signal: controller.signal });
    assert.equal(first.approved, false);

    const store1 = new EventStore(dbPath);
    const midEvents = store1.replay(first.sessionId);
    store1.close();
    assert.equal(midEvents.filter((e) => e.type === "PhaseEntered" && (e.payload as { phase: string }).phase === "EXECUTE").length, 1);
    assert.equal(midEvents.some((e) => e.type === "PhaseExited" && (e.payload as { phase: string }).phase === "EXECUTE"), false, "execution must have been interrupted, not completed");

    const activity: string[] = [];
    const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath, onActivity: (a) => activity.push(a.message) });
    assert.ok(activity[0].includes("WORK_AUDIT round 1"), `expected resume to jump straight to the work audit, got: ${activity[0]}`);
    assert.equal(resumed.approved, true);

    const store2 = new EventStore(dbPath);
    const finalEvents = store2.replay(first.sessionId);
    store2.close();
    assert.equal(finalEvents.filter((e) => e.type === "WorktreeCreated").length, 1);
    assert.equal(
      finalEvents.filter((e) => e.type === "PhaseEntered" && (e.payload as { phase: string }).phase === "EXECUTE").length,
      1,
      "resume must not re-run execution after an EXECUTE interruption — it should go straight to audit",
    );
  } finally {
    if (originalEnv === undefined) delete process.env.RESUME_TEST_MARKER;
    else process.env.RESUME_TEST_MARKER = originalEnv;
  }
});

test("resumes a REMEDIATE interruption at the matching audit round", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-resume-remediate-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-remediate-scratch-"));
  const provider = join(scratch, "fast.mjs");
  await writeFile(
    provider,
    `
const id = process.argv[2];
console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: { promptTokens: 1, completionTokens: 2 } }));
`,
  );
  const seats = ["claude", "codex", "antigravity"].map((id) => seatCfg(id, [provider, id, "{prompt}"]));

  const sessionId = `resume-test-remediate-${Date.now()}`;
  const branch = `conclave/${sessionId}`;
  const worktreePath = join(scratch, "wt");
  const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, baseCommit], { cwd: dir });

  const dbPath = join(scratch, "events.db");
  const store = new EventStore(dbPath);
  store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "test", budgetCeilingUsd: 20, minQuorum: 2 } });
  store.append(sessionId, {
    type: "SessionConfigured",
    payload: { configVersion: 1, repoPath: dir, seats, discussionRoundCap: 6, remediationRoundCap: 3, budgetCeilingUsd: 20, allowDirtySource: false },
  });
  store.append(sessionId, { type: "WorktreeCreated", payload: { baseCommit, branch, path: worktreePath } });
  store.append(sessionId, { type: "PhaseEntered", payload: { phase: "REMEDIATE", round: 1 } });
  store.close();

  const activity: string[] = [];
  const resumed = await resumeCouncil({ sessionId, dbPath, onActivity: (a) => activity.push(a.message) });
  assert.ok(activity[0].includes("RE_AUDIT round 2"), `expected resume to re-audit the remediated round, got: ${activity[0]}`);
  assert.equal(resumed.approved, true);

  const finalStore = new EventStore(dbPath);
  const events = finalStore.replay(sessionId);
  finalStore.close();
  assert.equal(events.filter((e) => e.type === "WorktreeCreated").length, 1, "resume must never create a second worktree");
  assert.equal(events.filter((e) => e.type === "SessionResumed").length, 1);
});

test("refuses to resume a session that already completed successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-resume-completed-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-completed-scratch-"));
  const provider = join(scratch, "provider.mjs");
  await writeFile(
    provider,
    `
const id = process.argv[2];
console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: { promptTokens: 1, completionTokens: 2 } }));
`,
  );
  const seats = ["claude", "codex", "antigravity"].map((id) => seatCfg(id, [provider, id, "{prompt}"]));
  const dbPath = join(scratch, "events.db");
  const result = await runCouncil({ task: "test", cwd: dir, dbPath, seats });
  assert.equal(result.approved, true);

  await assert.rejects(
    () => resumeCouncil({ sessionId: result.sessionId, dbPath }),
    /already completed/i,
  );

  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(status.worktreeRemoved !== undefined, true);
});

test("refuses to resume when the recorded worktree is missing or on the wrong branch", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-mismatch-scratch-"));
  const dbPath = join(scratch, "events.db");
  const seats = [seatCfg("claude", []), seatCfg("codex", []), seatCfg("antigravity", [])];
  const sessionId = "resume-test-missing-worktree";
  const store = new EventStore(dbPath);
  store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "test", budgetCeilingUsd: 20, minQuorum: 2 } });
  store.append(sessionId, {
    type: "SessionConfigured",
    payload: { configVersion: 1, repoPath: scratch, seats, discussionRoundCap: 6, remediationRoundCap: 3, budgetCeilingUsd: 20, allowDirtySource: false },
  });
  store.append(sessionId, {
    type: "WorktreeCreated",
    payload: { baseCommit: "deadbeef", branch: `conclave/${sessionId}`, path: join(scratch, "does-not-exist") },
  });
  store.append(sessionId, { type: "SessionErrored", payload: { message: "crashed", fatal: true } });
  store.close();

  await assert.rejects(() => resumeCouncil({ sessionId, dbPath }), /worktree/i);
});

test("refuses to resume a session recorded before SessionConfigured was tracked", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-schema-gap-scratch-"));
  const dbPath = join(scratch, "events.db");
  const sessionId = "resume-test-schema-gap";
  const store = new EventStore(dbPath);
  store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "test", budgetCeilingUsd: 20, minQuorum: 2 } });
  store.append(sessionId, {
    type: "WorktreeCreated",
    payload: { baseCommit: "deadbeef", branch: `conclave/${sessionId}`, path: join(scratch, "wt") },
  });
  store.append(sessionId, { type: "SessionCancelled", payload: { reason: "test" } });
  store.close();

  await assert.rejects(() => resumeCouncil({ sessionId, dbPath }), /SessionConfigured|predates/i);
});

test("rejects a concurrent resume against a session that already has one in progress", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-lock-scratch-"));
  const dbPath = join(scratch, "events.db");
  const sessionId = "resume-test-lock";
  const store = new EventStore(dbPath);
  store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "test", budgetCeilingUsd: 20, minQuorum: 2 } });
  store.append(sessionId, {
    type: "SessionConfigured",
    payload: { configVersion: 1, repoPath: scratch, seats: [seatCfg("claude", [])], discussionRoundCap: 6, remediationRoundCap: 3, budgetCeilingUsd: 20, allowDirtySource: false },
  });
  store.append(sessionId, {
    type: "WorktreeCreated",
    payload: { baseCommit: "deadbeef", branch: `conclave/${sessionId}`, path: join(scratch, "does-not-exist") },
  });
  store.append(sessionId, { type: "SessionErrored", payload: { message: "crashed", fatal: true } });
  store.close();

  // resumeCouncil acquires its lock synchronously before its first await, so firing both calls
  // back-to-back deterministically exercises the concurrent-rejection path without any hang script.
  const first = resumeCouncil({ sessionId, dbPath });
  const second = resumeCouncil({ sessionId, dbPath });
  await assert.rejects(() => second, /already has a run or resume in progress/i);
  await assert.rejects(() => first, /worktree/i); // the fabricated worktree is still missing
});

test("cancelling a resumed session again records a second SessionCancelled without corrupting state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-resume-recancel-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-recancel-scratch-"));
  const provider = join(scratch, "hang.mjs");
  await writeFile(provider, `setInterval(() => {}, 1000);\n`);
  const seats = ["claude", "codex", "antigravity"].map((id) => seatCfg(id, [provider]));
  const dbPath = join(scratch, "events.db");

  // This provider hangs on every call, so the run blocks in PLAN — the first phase to invoke a
  // seat — and never reaches PLAN_AUDIT. Cancel there, and again when the resume re-enters it.
  const controller1 = new AbortController();
  abortAfterEvent(dbPath, controller1, enteredPlan, "cancel 1");
  const first = await runCouncil({ task: "test", cwd: dir, dbPath, seats, signal: controller1.signal });
  assert.equal(first.approved, false);

  const controller2 = new AbortController();
  abortAfterEventCount(dbPath, controller2, enteredPlan, 2, "cancel 2");
  const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath, signal: controller2.signal });
  assert.equal(resumed.approved, false);

  const store = new EventStore(dbPath);
  const events = store.replay(first.sessionId);
  store.close();
  assert.equal(events.filter((e) => e.type === "SessionCancelled").length, 2);
  assert.equal(events.filter((e) => e.type === "SessionResumed").length, 1);
  assert.equal(events.filter((e) => e.type === "WorktreeCreated").length, 1);
  assert.equal(events.filter((e) => e.type === "SessionErrored").length, 0);
});

test("carries prior budget spend forward across a resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-resume-budget-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-budget-scratch-"));
  const provider = join(scratch, "costed.mjs");
  const marker = join(scratch, "marker");
  // Hangs on its first invocation only; afterward responds fast, and the claude seat additionally
  // emits a real claude-style usage envelope so recordSpend records an actual, non-zero cost.
  await writeFile(
    provider,
    `
import { existsSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const marker = process.env.RESUME_TEST_MARKER;
if (!existsSync(marker)) {
  try { writeFileSync(marker, "1", { flag: "wx" }); } catch {}
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: { promptTokens: 1, completionTokens: 2 } }));
  if (id === "claude") {
    console.log(JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }));
  }
}
`,
  );
  const seats = ["claude", "codex", "antigravity"].map((id) => seatCfg(id, [provider, id, "{prompt}"]));
  const dbPath = join(scratch, "events.db");
  const originalEnv = process.env.RESUME_TEST_MARKER;
  process.env.RESUME_TEST_MARKER = marker;
  try {
    const controller = new AbortController();
    abortAfterEvent(dbPath, controller, enteredRound0, "simulated crash");
    const first = await runCouncil({ task: "test", cwd: dir, dbPath, seats, budgetCeilingUsd: 1000, signal: controller.signal });
    assert.equal(first.approved, false);

    // Inject a prior spend that a broken resume (one that resets spentUsd to zero) could never
    // reach on its own with only a handful of $0.01 claude invocations.
    const store = new EventStore(dbPath);
    store.append(first.sessionId, {
      type: "BudgetSpent",
      payload: { correlationId: "prior-spend", seat: "claude", phase: "PLAN_AUDIT", round: 0, usageAvailable: true, promptTokens: 1, completionTokens: 1, costUsd: 2.5, costSource: "provider_reported", latencyMs: 0 },
    });
    store.close();

    const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath });
    assert.equal(resumed.approved, true);

    const status = getSessionStatus(dbPath, first.sessionId);
    assert.ok(status.spentUsd > 2.5, `expected spend to carry forward past the injected 2.5 baseline, got ${status.spentUsd}`);
    assert.ok(status.spentUsd < 3.5, `expected spend to stay close to the injected baseline plus a few small increments, got ${status.spentUsd}`);
  } finally {
    if (originalEnv === undefined) delete process.env.RESUME_TEST_MARKER;
    else process.env.RESUME_TEST_MARKER = originalEnv;
  }
});

test("reclaims a lock left by a crashed process, but respects one still held by a live process", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-resume-stale-lock-scratch-"));
  const dbPath = join(scratch, "events.db");
  const sessionId = "resume-test-stale-lock";
  const seats = [seatCfg("claude", [])];
  const store = new EventStore(dbPath);
  store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "test", budgetCeilingUsd: 20, minQuorum: 2 } });
  store.append(sessionId, {
    type: "SessionConfigured",
    payload: { configVersion: 1, repoPath: scratch, seats, discussionRoundCap: 6, remediationRoundCap: 3, budgetCeilingUsd: 20, allowDirtySource: false },
  });
  store.append(sessionId, {
    type: "WorktreeCreated",
    payload: { baseCommit: "deadbeef", branch: `conclave/${sessionId}`, path: join(scratch, "does-not-exist") },
  });
  store.append(sessionId, { type: "SessionErrored", payload: { message: "crashed", fatal: true } });
  store.close();

  const lockDir = join(scratch, ".locks");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${sessionId}.lock`);

  // A lock recorded against a PID that is now genuinely dead (simulating a crashed process that
  // never ran its cleanup) must be reclaimed rather than permanently blocking the session.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(dead.pid);
  writeFileSync(lockPath, String(dead.pid), { flag: "w" });
  await assert.rejects(
    () => resumeCouncil({ sessionId, dbPath }),
    /worktree/i, // the lock was reclaimed; it then fails for the expected fabricated-worktree reason
  );

  // A lock recorded against a PID that is still alive (this test process itself) must be respected.
  writeFileSync(lockPath, String(process.pid), { flag: "w" });
  await assert.rejects(() => resumeCouncil({ sessionId, dbPath }), /already has a run or resume in progress/i);
  rmSync(lockPath, { force: true });
});
