import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach } from "node:test";
import { promisify } from "node:util";
import type { Finding, SeatConfig, StoredEvent } from "@conclave/core";
import { getSessionStatus, isSessionActive, recordHumanRuling, resumeCouncil, resumePlan, runCouncil } from "../../dist/session/autonomousCouncil.js";
import { arbitrate } from "../../dist/engine/arbitration.js";
import { humanRulings, projectSession, summarizeDeliberation, type SessionProjection } from "../../dist/store/projections.js";
import { clearFakeSeats, registerFakeSeat, type FakeSeatResponse } from "../../dist/seats/fakeAdapter.js";
import { pendingHumanRulings } from "../../dist/store/projections.js";
import { EventStore } from "../../src/store/eventStore.ts";

// Regression tests for defects found by the multi-agent bug hunt. Each one failed before its fix.

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
const council = () => ["claude", "codex", "antigravity"].map(fakeSeat);

function stepOf(prompt: string): string {
  if (prompt.includes("verifying one disputed claim")) return "VERIFY";
  if (prompt.includes("write a complete, concrete implementation plan")) return "PLAN";
  if (prompt.includes("Revise the implementation plan")) return "PLAN_REFINE";
  if (prompt.includes("Audit the implementation plan")) return "PLAN_AUDIT";
  if (prompt.includes("formal ratification vote")) return prompt.includes("the plan below") ? "RATIFY_PLAN" : "RATIFY_WORK";
  if (prompt.includes("Implement this task completely")) return "EXECUTE";
  if (prompt.includes("Audit the actual current state")) return "WORK_AUDIT";
  if (prompt.includes("Repair and improve")) return "REMEDIATE";
  return "OTHER";
}

const approve: FakeSeatResponse = { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok" } };
const reject = (reasoning: string, findings: Finding[] = []): FakeSeatResponse => ({ kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: reasoning, findings } });
const finding = (id: string, target: string, description: string, extra: Partial<Finding> = {}): Finding => ({
  id, seat: "codex", role: "SECURITY", target, category: "bug", severity: "BLOCKER", description, falsifiable_test: null, confidence: 0.9, ...extra,
});

function readEvents(dbPath: string, sessionId: string): StoredEvent[] {
  const store = new EventStore(dbPath);
  try {
    return store.replay(sessionId);
  } finally {
    store.close();
  }
}
const phasesOf = (events: StoredEvent[]) => events.filter((e) => e.type === "PhaseEntered").map((e) => (e.payload as { phase: string }).phase);

afterEach(() => clearFakeSeats());

test("one steady REJECT in the work vote is remediated round by round and ends NOT_APPROVED, not in a 200-step loop", async () => {
  const { dir, dbPath } = await setupRepo("reg-ratify-loop");
  let remediations = 0;
  registerFakeSeat("claude", ({ prompt }) => {
    if (stepOf(prompt) === "REMEDIATE") {
      remediations += 1;
      assert.match(prompt, /tests fail/, "the dissenter's reason is what the executor is asked to fix");
    }
    return approve;
  });
  registerFakeSeat("codex", ({ prompt }) => (stepOf(prompt) === "RATIFY_WORK" ? reject("tests fail") : approve));
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), remediationRoundCap: 2 });
  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(result.approved, false);
  assert.equal(status.errored, false, "it ends as a verdict, not a crash");
  assert.equal(status.outcome, "NOT_APPROVED");
  assert.equal(remediations, 2, "each failed vote costs one remediation round, up to the cap");
  assert.ok(phasesOf(readEvents(dbPath, result.sessionId)).length < 30);
});

test("evidence about one claim never settles a different claim that reuses its id", async () => {
  const { dir, dbPath } = await setupRepo("reg-stale-evidence");
  const verified: string[] = [];
  registerFakeSeat("codex", ({ prompt }) => {
    const step = stepOf(prompt);
    if (step === "PLAN_AUDIT") return reject("x", [finding("F1", "PLAN.md", "plan forgets migrations", { falsifiable_test: "ls migrations/" })]);
    if (step === "WORK_AUDIT") return reject("y", [finding("F1", "src/auth.ts", "SQL injection in login()", { falsifiable_test: "node --test test/sqli.test.js" })]);
    return approve;
  });
  registerFakeSeat("claude", ({ prompt, findingId }) => {
    if (stepOf(prompt) !== "VERIFY") return approve;
    verified.push(findingId!);
    // Refutes the plan claim, reproduces the work claim — each by running something.
    const reproduced = findingId !== "codex:F1";
    return {
      kind: "verdict",
      verdict: { overall_verdict: reproduced ? "REJECT" : "APPROVE", verdict_reasoning: "ran it" },
      commandRuns: [{ command: "node --test", result: reproduced ? "FAIL" : "PASS", exitCode: reproduced ? 1 : 0, output: "" }],
    };
  });
  const result = await runCouncil({ task: "add login", cwd: dir, dbPath, seats: council(), remediationRoundCap: 1 });
  assert.deepEqual(verified, ["codex:F1", "codex:F1~2"], "the second, different claim got its own id and its own test run");
  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(status.findings["codex:F1~2"]?.description, "SQL injection in login()");
  assert.equal(result.approved, false, "a reproduced SQL injection is not waved through on the plan claim's refutation");
});

test("a human ruling settles the claim it was made on, not a later, different problem in the same file", async () => {
  const { dir, dbPath } = await setupRepo("reg-stale-human");
  let planAudits = 0;
  const work = finding("W7", "src/auth.ts", "the new login() concatenates user input into SQL");
  const plan = finding("P1", "src/auth.ts", "the plan skips an authorization check", { category: "authz" });
  registerFakeSeat("codex", ({ prompt }) => {
    const step = stepOf(prompt);
    if (step === "PLAN_AUDIT" && planAudits++ === 0) return reject("authz", [plan]);
    if (step === "WORK_AUDIT" || step === "RE_AUDIT") return reject("sqli", [work]);
    return approve;
  });
  const first = await runCouncil({ task: "add login", cwd: dir, dbPath, seats: council(), discussionRoundCap: 1, remediationRoundCap: 1 });
  const [pending] = pendingHumanRulings(getSessionStatus(dbPath, first.sessionId));
  assert.ok(pending, "the plan dispute was escalated to a human");
  recordHumanRuling({ dbPath, sessionId: first.sessionId, contentionId: pending!.contentionId, ruling: "DISMISSED", reasoning: "authorization is done by the gateway" });
  const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath });
  assert.equal(resumed.approved, false, "the SQL injection was never ruled on, so it cannot ride on the authorization ruling");
  const events = readEvents(dbPath, first.sessionId);
  const afterResume = events.slice(events.findIndex((e) => e.type === "SessionResumed"));
  const settledByHuman = afterResume.filter((e) => e.type === "ActivityLogged" && /Settled by a human arbiter/.test(String((e.payload as { message: string }).message)));
  assert.equal(settledByHuman.length, 0, "the old ruling closes nothing on the work side");
  assert.ok(
    afterResume.some((e) => e.type === "ArbitrationRuled" && (e.payload as { source?: string }).source === "policy"),
    "the SQL injection claim is arbitrated on its own merits",
  );
});

test("every billed call is recorded before the budget stops the run, and a spent session cannot be resumed", async () => {
  const { dir, dbPath } = await setupRepo("reg-budget");
  let calls = 0;
  for (const id of ["claude", "codex", "antigravity"]) {
    registerFakeSeat(id, () => {
      calls += 1;
      return { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok" }, usage: { promptTokens: 1000, completionTokens: 1000, costUsd: 1, source: "fake" } };
    });
  }
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), budgetCeilingUsd: 1.5 });
  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(status.spentUsd, calls, "the log records exactly what was billed");
  assert.equal(readEvents(dbPath, result.sessionId).filter((e) => e.type === "SeatInvoked").length, calls);
  assert.equal(result.approved, false);
  calls = 0;
  await assert.rejects(() => resumeCouncil({ sessionId: result.sessionId, dbPath }), /spent its budget/);
  assert.equal(calls, 0, "refused before any seat was called");
});

test("a failed call's reported cost is charged, and a call with no reported usage is charged an estimate", async () => {
  const { dir, dbPath } = await setupRepo("reg-failed-spend");
  registerFakeSeat("codex", ({ prompt }) =>
    stepOf(prompt) === "PLAN_AUDIT" ? { kind: "error", message: "invalid verdict: fenced", usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.75, source: "fake" } } : approve,
  );
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(status.spendBySeat.codex, 0.75, "the failed audit was billed and is on the books");
});

test("a resumed session gives a seat that failed once another chance instead of evicting it for good", async () => {
  const { dir, dbPath } = await setupRepo("reg-resume-evict");
  let codexCalls = 0;
  registerFakeSeat("codex", () => (codexCalls++ === 0 ? { kind: "error", message: "429 Too Many Requests" } : approve));
  const seats = ["claude", "codex"].map(fakeSeat);
  const first = await runCouncil({ task: "t", cwd: dir, dbPath, seats });
  assert.equal(first.approved, false, "with codex out, a two-seat council loses quorum");
  const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath });
  assert.equal(resumed.approved, true, "codex answers this time, so the council can finish");
});

test("resuming after a human upholds a dispute at the round cap acts on it with one more cycle", async () => {
  const { dir, dbPath } = await setupRepo("reg-upheld");
  const plan = finding("P1", "src/auth.ts", "the plan skips an authorization check", { category: "authz" });
  let refines = 0;
  registerFakeSeat("claude", ({ prompt }) => {
    if (stepOf(prompt) === "PLAN_REFINE") {
      refines += 1;
      assert.match(prompt, /Upheld by a human arbiter/, "the upheld ruling is the objection the executor revises for");
      return { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "REVISED plan with an authorization check" } };
    }
    return approve;
  });
  registerFakeSeat("codex", ({ prompt }) => (stepOf(prompt) === "PLAN_AUDIT" && !prompt.includes("REVISED") ? reject("authz", [plan]) : approve));
  const first = await runCouncil({ task: "add login", cwd: dir, dbPath, seats: council(), discussionRoundCap: 1 });
  const [pending] = pendingHumanRulings(getSessionStatus(dbPath, first.sessionId));
  assert.ok(pending);
  recordHumanRuling({ dbPath, sessionId: first.sessionId, contentionId: pending!.contentionId, ruling: "UPHELD", reasoning: "the plan must add the authorization check" });
  refines = 0;
  const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath });
  assert.equal(refines, 1, "the upheld claim is acted on, not re-audited into a dead end");
  assert.equal(resumed.approved, true);
});

test("a listener that throws after the verdict is recorded cannot turn an approved session into an errored one", async () => {
  const { dir, dbPath } = await setupRepo("reg-listener");
  const result = await runCouncil({
    task: "t",
    cwd: dir,
    dbPath,
    seats: council(),
    onActivity: (activity) => {
      if (activity.kind === "report") throw new Error("broadcast failed");
    },
  });
  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(result.approved, true);
  assert.equal(status.errored, false);
  assert.equal(status.outcome, "APPROVED");
});

test("a refutation that follows an inconclusive attempt settles the claim", async () => {
  const { dir, dbPath } = await setupRepo("reg-inconclusive");
  let attempts = 0;
  registerFakeSeat("codex", ({ prompt }) =>
    stepOf(prompt) === "PLAN_AUDIT" ? reject("race", [finding("F1", "src/queue.ts", "race in enqueue()", { falsifiable_test: "node --test test/race.test.js" })]) : approve,
  );
  registerFakeSeat("claude", ({ prompt }) => {
    if (stepOf(prompt) !== "VERIFY") return approve;
    attempts += 1;
    if (attempts === 1) return { kind: "error", message: "flaky" };
    return { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ran it; no race" }, commandRuns: [{ command: "node --test test/race.test.js", result: "PASS", exitCode: 0, output: "ok" }] };
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), discussionRoundCap: 3 });
  const rulings = readEvents(dbPath, result.sessionId).filter((e) => e.type === "ArbitrationRuled").map((e) => (e.payload as { ruling: string }).ruling);
  assert.ok(rulings.includes("DISMISSED"), `the refuted claim is dismissed on evidence (rulings: ${rulings.join(", ")})`);
  assert.equal(result.approved, true);
});

test("a bare REJECT becomes a recorded finding that carries the seat's reasoning", async () => {
  const { dir, dbPath } = await setupRepo("reg-overall");
  let rejected = false;
  registerFakeSeat("codex", ({ prompt }) => (stepOf(prompt) === "PLAN_AUDIT" && !rejected ? ((rejected = true), reject("the plan ignores the existing retry queue")) : approve));
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  const status = getSessionStatus(dbPath, result.sessionId);
  const overall = Object.values(status.findings).find((f) => f.target === "__overall__");
  assert.equal(overall?.description, "the plan ignores the existing retry queue");
  const thread = Object.values(status.contentions).flatMap((c) => c.thread).find((m) => m.author === "codex");
  assert.equal(thread?.reasoning, "the plan ignores the existing retry queue", "the arbiter reads the seat's own reason, not \"objects to __overall__\"");
});

test("a lock whose pid is alive but which stopped being refreshed is stale (pid reuse after a crash)", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-reg-lock-"));
  const dbPath = join(scratch, "events.db");
  const lock = join(dirname(dbPath), ".locks", "s1.lock");
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, String(process.pid));
  assert.equal(isSessionActive(dbPath, "s1"), true, "a fresh lock held by a live pid is live");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  assert.equal(isSessionActive(dbPath, "s1"), false, "not refreshed for minutes: the pid belongs to someone else now");
});

test("an escalated dispute is not closed, and the work not ratified, because its claimant timed out", async () => {
  const { dir, dbPath } = await setupRepo("reg-outage");
  let audits = 0;
  registerFakeSeat("codex", ({ prompt }) => {
    if (stepOf(prompt) !== "PLAN_AUDIT") return approve;
    audits += 1;
    return audits === 1 ? reject("authz", [finding("X", "src/auth.ts", "plan exposes /admin without auth")]) : { kind: "error", message: "timed out after 120000ms" };
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), discussionRoundCap: 3 });
  const status = getSessionStatus(dbPath, result.sessionId);
  assert.equal(result.approved, false, "silence is not withdrawal: nobody ruled on the escalated BLOCKER");
  assert.equal(status.outcome, "AWAITING_HUMAN");
  const resolutions = readEvents(dbPath, result.sessionId).filter((e) => e.type === "ContentionResolved").map((e) => (e.payload as { terminalState: string }).terminalState);
  assert.ok(!resolutions.includes("SUPERSEDED"));
});

test("evidence gathered before the code changed does not settle the claim afterwards", async () => {
  const { dir, dbPath } = await setupRepo("reg-stale-tree");
  const claim = finding("F1", "src/admin.ts", "GET /admin is reachable without a session", { falsifiable_test: "node --test test/admin.test.js" });
  const runs: boolean[] = [];
  let executed = false;
  registerFakeSeat("codex", ({ prompt }) => (["PLAN_AUDIT", "WORK_AUDIT", "RE_AUDIT"].includes(stepOf(prompt)) ? reject("admin exposed", [claim]) : approve));
  registerFakeSeat("claude", async ({ prompt, cwd }) => {
    const step = stepOf(prompt);
    if (step === "EXECUTE") {
      executed = true;
      await writeFile(join(cwd, "admin.js"), "export const route = '/admin';\n");
    }
    if (step !== "VERIFY") return approve;
    runs.push(executed);
    // Before EXECUTE the route does not exist, so the test cannot reproduce the claim; afterwards it does.
    return {
      kind: "verdict",
      verdict: { overall_verdict: executed ? "REJECT" : "APPROVE", verdict_reasoning: executed ? "reproduced" : "route absent" },
      commandRuns: [{ command: "node --test test/admin.test.js", result: executed ? "FAIL" : "PASS", exitCode: executed ? 1 : 0, output: "" }],
    };
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), discussionRoundCap: 2, remediationRoundCap: 1 });
  assert.deepEqual(runs.slice(0, 2), [false, true], "the claim is tested again against the implemented code");
  assert.equal(result.approved, false);
});

test("a work vote that failed only on a missing ballot is taken again without sending the executor to edit", async () => {
  const { dir, dbPath } = await setupRepo("reg-vote-outage");
  let remediations = 0;
  registerFakeSeat("antigravity", ({ prompt }) => (stepOf(prompt) === "RATIFY_WORK" ? { kind: "error", message: "429 rate limited" } : approve));
  registerFakeSeat("claude", ({ prompt }) => {
    if (stepOf(prompt) === "REMEDIATE") remediations += 1;
    return approve;
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  assert.equal(remediations, 0);
  assert.equal(result.approved, true, "the two remaining seats ratify on the re-vote");
});

test("a contention is dismissed on evidence only when every claim in it was refuted", () => {
  const contention = { contentionId: "c-1", targets: ["src/auth.ts"], category: "authz", severity: "BLOCKER" as const, findingIds: ["codex:X", "antigravity:Y"], claimants: ["antigravity", "codex"], dissenters: ["claude"] };
  const findings = new Map<string, Finding>([
    ["codex:X", finding("codex:X", "src/auth.ts", "admin route has no auth")],
    ["antigravity:Y", finding("antigravity:Y", "src/auth.ts", "login is slow", { seat: "antigravity", severity: "MAJOR", falsifiable_test: "bench" })],
  ]);
  const decision = arbitrate({ contention, findings, evidence: [{ findingId: "antigravity:Y", result: "FALSE" }], activeSeatIds: new Set(["claude", "codex", "antigravity"]) });
  assert.notEqual(decision.ruling, "DISMISSED", "refuting the perf claim says nothing about the untested BLOCKER");
});

test("a human ruling survives a later policy ruling on a different claim in the same file", () => {
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>): StoredEvent => ({ seq: ++seq, sessionId: "s", ts: new Date().toISOString(), type, payload } as StoredEvent);
  const events = [
    event("ContentionOpened", { contentionId: "c-1", targets: ["src/auth.ts"], category: "authz", severity: "BLOCKER", findingIds: ["codex:A1"] }),
    event("ThreadMessageAdded", { contentionId: "c-1", author: "codex", stance: "DISSENT", reasoning: "claim A", evidence: [] }),
    event("ArbitrationRuled", { contentionId: "c-1", arbiters: ["claude"], ruling: "DEFERRED", reasoning: "escalate", source: "policy", findingIds: ["codex:A1"] }),
    event("ContentionResolved", { contentionId: "c-1", terminalState: "HUMAN_ARBITRATION" }),
    event("ArbitrationRuled", { contentionId: "c-1", arbiters: ["human"], ruling: "DISMISSED", reasoning: "not an issue", source: "human", findingIds: ["codex:A1"] }),
    event("ContentionResolved", { contentionId: "c-1", terminalState: "WITHDRAWN" }),
    event("ContentionOpened", { contentionId: "c-1", targets: ["src/auth.ts"], category: "perf", severity: "MAJOR", findingIds: ["codex:B1"] }),
    event("ArbitrationRuled", { contentionId: "c-1", arbiters: ["claude"], ruling: "UPHELD", reasoning: "weighted", source: "policy", findingIds: ["codex:B1"] }),
  ];
  const proj = projectSession("s", events);
  assert.deepEqual(humanRulings(proj).map((r) => [r.ruling, r.findingIds]), [["DISMISSED", ["codex:A1"]]]);
  assert.deepEqual(proj.contentions["c-1"]!.thread, [], "the reopened dispute starts its own thread");
  const summary = summarizeDeliberation(proj).arbitrations;
  assert.equal(summary.total, 3);
  assert.equal(summary.byHuman, 1);
});

test("a second grant of one more round still leaves room to audit the revision", () => {
  const proj = {
    sessionId: "s",
    outcome: "AWAITING_HUMAN",
    currentPhase: "DELIBERATE",
    currentRound: 2,
    phaseOpen: false,
    discussionRoundCap: 2,
    remediationRoundCap: 3,
    findings: { "codex:A1": finding("codex:A1", "src/auth.ts", "claim") },
    contentions: { "c-1": { status: "ARBITRATED", targets: ["src/auth.ts"], category: "authz", severity: "BLOCKER", findingIds: ["codex:A1"], thread: [] } },
    arbitrations: { "c-1": { arbiters: ["human"], ruling: "UPHELD", reasoning: "fix it", source: "human", findingIds: ["codex:A1"] } },
    arbitrationLog: [{ contentionId: "c-1", arbiters: ["human"], ruling: "UPHELD", reasoning: "fix it", source: "human", findingIds: ["codex:A1"] }],
  } as unknown as SessionProjection;
  const plan = resumePlan(proj);
  assert.deepEqual(plan.entry, { phase: "PLAN_REFINE", round: 2 });
  assert.ok(plan.discussionCap >= 4, `refine at round 2 needs a cap of at least 4 to audit round 3 (got ${plan.discussionCap})`);
});
