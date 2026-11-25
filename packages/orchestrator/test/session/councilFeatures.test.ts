import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { promisify } from "node:util";
import type { SeatConfig, StoredEvent } from "@conclave/core";
import {
  cancelRequestPath,
  getSessionStatus,
  recordHumanRuling,
  requestCancel,
  resumeCouncil,
  runCouncil,
} from "../../dist/session/autonomousCouncil.js";
import { clearFakeSeats, registerFakeSeat, type FakeSeatResponse } from "../../dist/seats/fakeAdapter.js";
import { pendingHumanRulings } from "../../dist/store/projections.js";
import { EventStore } from "../../src/store/eventStore.ts";

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

/** Which step of the council a prompt belongs to, recovered from the prompt text the driver sends. */
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

function readEvents(dbPath: string, sessionId: string): StoredEvent[] {
  const store = new EventStore(dbPath);
  try {
    return store.replay(sessionId);
  } finally {
    store.close();
  }
}
const payloads = <T>(events: StoredEvent[], type: string): T[] =>
  events.filter((event) => event.type === type).map((event) => event.payload as T);

afterEach(() => clearFakeSeats());

test("a resumed session audits and executes the plan it was working on, restored from the event log", async () => {
  const { dir, dbPath } = await setupRepo("resume-plan");
  const prompts: Array<{ seat: string; step: string; prompt: string }> = [];
  const controller = new AbortController();
  let interrupted = false;
  for (const id of ["claude", "codex", "antigravity"]) {
    registerFakeSeat(id, ({ prompt }) => {
      const step = stepOf(prompt);
      prompts.push({ seat: id, step, prompt });
      if (id === "claude" && step === "PLAN") {
        return { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "Add a guard to src/index.ts. (marker PLAN-7f3a)" } };
      }
      if (id === "codex" && step === "PLAN_AUDIT" && !interrupted) {
        interrupted = true;
        controller.abort(new Error("simulated crash mid-audit"));
        return { kind: "hang" };
      }
      return approve;
    });
  }

  const first = await runCouncil({ task: "guard the index", cwd: dir, dbPath, seats: council(), signal: controller.signal });
  assert.equal(first.approved, false);
  assert.equal(getSessionStatus(dbPath, first.sessionId).planText, "Add a guard to src/index.ts. (marker PLAN-7f3a)");

  prompts.length = 0;
  const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath });
  assert.equal(resumed.approved, true);

  assert.equal(prompts.filter((p) => p.step === "PLAN").length, 0, "resume must not redraft a plan that already exists");
  const audits = prompts.filter((p) => p.step === "PLAN_AUDIT");
  assert.equal(audits.length, 3);
  for (const audit of audits) assert.ok(audit.prompt.includes("PLAN-7f3a"), `${audit.seat}'s resumed plan audit was sent without the plan`);
  const execute = prompts.find((p) => p.step === "EXECUTE");
  assert.ok(execute?.prompt.includes("PLAN-7f3a"), "EXECUTE after a resume must implement the ratified plan, not an empty one");
  const ratify = prompts.find((p) => p.step === "RATIFY_PLAN");
  assert.ok(ratify?.prompt.includes("PLAN-7f3a"));
});

const raceFinding = {
  id: "f-race",
  seat: "codex",
  role: "CORRECTNESS" as const,
  target: "src/queue.ts",
  category: "race",
  severity: "MAJOR" as const,
  description: "concurrent enqueue loses items",
  falsifiable_test: "node --test test/queue.test.js",
  confidence: 0.8,
};

test("an executed falsifiable test that reproduces a claim upholds it, overriding a weighted policy that would have dismissed it", async () => {
  const { dir, dbPath } = await setupRepo("verify-true");
  let codexAudits = 0;
  const verifierPrompts: string[] = [];
  registerFakeSeat("codex", ({ prompt }) => {
    if (stepOf(prompt) === "PLAN_AUDIT" && codexAudits++ === 0) {
      return { kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: "race", findings: [raceFinding] } };
    }
    return approve;
  });
  registerFakeSeat("claude", ({ prompt, findingId }) => {
    if (stepOf(prompt) !== "VERIFY") return approve;
    verifierPrompts.push(prompt);
    assert.equal(findingId, "codex:f-race", "a verification invocation is scoped to the finding it verifies");
    return {
      kind: "verdict",
      verdict: { overall_verdict: "REJECT", verdict_reasoning: "ran the test: 1 failing (lost item)" },
      commandRuns: [{ command: "node --test test/queue.test.js", result: "FAIL", exitCode: 1, output: "not ok 1 - concurrent enqueue" }],
    };
  });

  const result = await runCouncil({ task: "fix the queue", cwd: dir, dbPath, seats: council() });
  assert.equal(result.approved, true);
  const events = readEvents(dbPath, result.sessionId);

  assert.equal(verifierPrompts.length, 1, "claude, a disinterested seat that can execute commands, verifies the claim");
  assert.ok(verifierPrompts[0].includes("node --test test/queue.test.js"));

  const runs = payloads<{ findingId: string; result: string; contentionId?: string; command: string }>(events, "VerificationRun");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].findingId, "codex:f-race");
  assert.equal(runs[0].result, "TRUE");
  assert.ok(runs[0].contentionId);
  assert.equal(runs[0].command, "node --test test/queue.test.js");
  assert.equal((runs[0] as { seat?: string }).seat, "claude", "the verification records which seat ran the test");

  const captured = payloads<{ findingId?: string; phase: string; result: string }>(events, "CommandVerificationRun");
  assert.deepEqual(captured.map((c) => [c.findingId, c.phase, c.result]), [["codex:f-race", "DELIBERATE", "FAIL"]]);

  // MAJOR at 0.8 confidence weighs 0.48 against 1.0 of dissent: policy alone would dismiss it.
  const rulings = payloads<{ ruling: string; reasoning: string; source: string }>(events, "ArbitrationRuled");
  assert.equal(rulings.length, 1);
  assert.equal(rulings[0].ruling, "UPHELD");
  assert.equal(rulings[0].source, "policy");
  assert.match(rulings[0].reasoning, /executed evidence/);
  assert.ok(payloads<{ phase: string }>(events, "PhaseEntered").some((p) => p.phase === "PLAN_REFINE"), "an upheld claim sends the plan back for revision");
});

test("an executed falsifiable test that fails to reproduce a contested BLOCKER dismisses it instead of escalating to a human", async () => {
  const { dir, dbPath } = await setupRepo("verify-false");
  registerFakeSeat("codex", ({ prompt }) =>
    stepOf(prompt) === "PLAN_AUDIT"
      ? { kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: "blocker", findings: [{ ...raceFinding, severity: "BLOCKER", confidence: 0.9 }] } }
      : approve,
  );
  registerFakeSeat("claude", ({ prompt }) =>
    stepOf(prompt) === "VERIFY"
      ? {
          kind: "verdict",
          verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ran the test: all passing" },
          commandRuns: [{ command: "node --test test/queue.test.js", result: "PASS", exitCode: 0, output: "# pass 4" }],
        }
      : approve,
  );

  const result = await runCouncil({ task: "fix the queue", cwd: dir, dbPath, seats: council() });
  assert.equal(result.approved, true);
  const events = readEvents(dbPath, result.sessionId);
  assert.deepEqual(payloads<{ result: string }>(events, "VerificationRun").map((r) => r.result), ["FALSE"]);
  assert.deepEqual(payloads<{ ruling: string }>(events, "ArbitrationRuled").map((r) => r.ruling), ["DISMISSED"]);
  assert.deepEqual(payloads<{ terminalState: string }>(events, "ContentionResolved").map((r) => r.terminalState), ["WITHDRAWN"]);
  assert.equal(payloads<{ phase: string }>(events, "PhaseEntered").some((p) => p.phase === "PLAN_REFINE"), false, "a refuted claim needs no plan revision");
});

test("a verification that ran nothing is inconclusive evidence, and arbitration falls back to policy", async () => {
  const { dir, dbPath } = await setupRepo("verify-inconclusive");
  let codexAudits = 0;
  registerFakeSeat("codex", ({ prompt }) =>
    stepOf(prompt) === "PLAN_AUDIT" && codexAudits++ === 0
      ? { kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: "race", findings: [raceFinding] } }
      : approve,
  );
  registerFakeSeat("claude", ({ prompt }) =>
    stepOf(prompt) === "VERIFY"
      ? {
          kind: "verdict",
          // Claims a reproduction, but its only command was denied: no evidence was actually produced.
          verdict: { overall_verdict: "REJECT", verdict_reasoning: "I am sure it fails" },
          commandRuns: [{ command: "node --test test/queue.test.js", result: "DENIED", output: "" }],
        }
      : approve,
  );

  const result = await runCouncil({ task: "fix the queue", cwd: dir, dbPath, seats: council() });
  const events = readEvents(dbPath, result.sessionId);
  assert.deepEqual(payloads<{ result: string }>(events, "VerificationRun").map((r) => r.result), ["INCONCLUSIVE"]);
  const [ruling] = payloads<{ ruling: string; reasoning: string }>(events, "ArbitrationRuled");
  assert.equal(ruling.ruling, "DISMISSED");
  assert.match(ruling.reasoning, /weighted policy/);
});

test("a contested BLOCKER still escalated when rounds run out stops the session AWAITING_HUMAN; a human ruling lets it resume and finish", async () => {
  const { dir, dbPath } = await setupRepo("human-arbitration");
  const authFinding = {
    id: "f-auth", seat: "codex", role: "SECURITY" as const, target: "src/auth.ts", category: "authz", severity: "BLOCKER" as const,
    description: "the plan skips authorization", falsifiable_test: null, confidence: 0.9,
  };
  const ratifyPrompts: string[] = [];
  // codex files the same blocker on every plan audit, and votes against ratification unless the
  // prompt tells it a human has settled the dispute.
  registerFakeSeat("codex", ({ prompt }) => {
    const step = stepOf(prompt);
    if (step === "PLAN_AUDIT") return { kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: "no authz", findings: [authFinding] } };
    if (step === "RATIFY_PLAN") {
      ratifyPrompts.push(prompt);
      return prompt.includes("settled by a human arbiter") ? approve : { kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: "no authz" } };
    }
    return approve;
  });

  const first = await runCouncil({ task: "add login", cwd: dir, dbPath, seats: council(), discussionRoundCap: 2 });
  assert.equal(first.approved, false);
  assert.match(first.report, /AWAITING HUMAN ARBITRATION/);
  assert.match(first.report, /conclave arbitrate/);

  const paused = getSessionStatus(dbPath, first.sessionId);
  assert.equal(paused.outcome, "AWAITING_HUMAN");
  assert.equal(paused.errored, false, "waiting on a human is not an error");
  assert.ok(paused.worktreeKept && !paused.worktreeRemoved);
  const pending = pendingHumanRulings(paused);
  assert.equal(pending.length, 1);
  const contentionId = pending[0].contentionId;
  assert.deepEqual(pending[0].targets, ["src/auth.ts"]);

  await assert.rejects(() => resumeCouncil({ sessionId: first.sessionId, dbPath }), /waiting on a human ruling/);
  assert.throws(() => recordHumanRuling({ dbPath, sessionId: first.sessionId, contentionId, ruling: "DISMISSED", reasoning: "  " }), /needs a reason/);
  assert.throws(() => recordHumanRuling({ dbPath, sessionId: first.sessionId, contentionId: "c-nope", ruling: "DISMISSED", reasoning: "x" }), /no contention/);

  recordHumanRuling({ dbPath, sessionId: first.sessionId, contentionId, ruling: "DISMISSED", reasoning: "authorization is enforced by the API gateway, not this service" });
  assert.equal(pendingHumanRulings(getSessionStatus(dbPath, first.sessionId)).length, 0);
  assert.throws(
    () => recordHumanRuling({ dbPath, sessionId: first.sessionId, contentionId, ruling: "UPHELD", reasoning: "changed my mind" }),
    /not awaiting a human ruling/,
    "a settled contention cannot be re-ruled",
  );

  const policyRulingsBefore = payloads<{ source: string }>(readEvents(dbPath, first.sessionId), "ArbitrationRuled").filter((r) => r.source === "policy").length;
  ratifyPrompts.length = 0;
  const resumed = await resumeCouncil({ sessionId: first.sessionId, dbPath });
  assert.equal(resumed.approved, true);

  const events = readEvents(dbPath, first.sessionId);
  const rulings = payloads<{ source: string; arbiters: string[] }>(events, "ArbitrationRuled");
  assert.equal(rulings.filter((r) => r.source === "human").length, 1);
  assert.equal(rulings.filter((r) => r.source === "policy").length, policyRulingsBefore, "a human-settled contention is never re-arbitrated by policy");
  assert.ok(ratifyPrompts.every((p) => p.includes("authorization is enforced by the API gateway")), "later votes are told how the human ruled");
  const final = getSessionStatus(dbPath, first.sessionId);
  assert.equal(final.outcome, "APPROVED");
  assert.equal(final.contentions[contentionId].status, "WITHDRAWN");
  assert.equal(events.filter((e) => e.type !== "ActivityLogged").at(-1)?.type, "SessionConcluded");
});

test("a council that is simply out of rounds, with nothing escalated, concludes NOT_APPROVED rather than as an error", async () => {
  const { dir, dbPath } = await setupRepo("not-approved");
  registerFakeSeat("codex", ({ prompt }) =>
    stepOf(prompt) === "PLAN_AUDIT" ? { kind: "verdict", verdict: { overall_verdict: "APPROVE_WITH_CHANGES", verdict_reasoning: "tighten it" } } : approve,
  );
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council(), discussionRoundCap: 1 });
  assert.equal(result.approved, false);
  const proj = getSessionStatus(dbPath, result.sessionId);
  assert.equal(proj.outcome, "NOT_APPROVED");
  assert.equal(proj.errored, false);
  assert.equal(proj.fatalError, undefined);
  assert.match(result.report, /Outcome: NOT APPROVED/);
});

test("conclave cancel from another process: a cancel request file stops the run like Ctrl-C would, and is cleaned up", async () => {
  const { dir, dbPath } = await setupRepo("cancel-file");
  const sessionId = `cancel-${randomUUID()}`;
  registerFakeSeat("claude", ({ prompt }) => {
    if (stepOf(prompt) !== "PLAN") return approve;
    requestCancel(dbPath, sessionId);
    return { kind: "hang" };
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, sessionId, seats: council() });
  assert.equal(result.approved, false);
  const proj = getSessionStatus(dbPath, sessionId);
  assert.equal(proj.cancelled, true);
  assert.match(proj.cancelReason ?? "", /conclave cancel/);
  assert.ok(proj.worktreeKept);
  assert.equal(existsSync(cancelRequestPath(dbPath, sessionId)), false, "the request file must not linger and cancel a later resume");
  assert.throws(() => requestCancel(dbPath, sessionId), /not running/);
});

test("a seat without filesystem access (xenia) is shown the repository: the file list, and the diff once work exists", async () => {
  const { dir, dbPath } = await setupRepo("xenia-context");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "src"], { cwd: dir });

  const received: string[] = [];
  const readBody = async (request: IncomingMessage) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    return JSON.parse(text) as { messages: Array<{ role: string; content: string }> };
  };
  const gateway = createServer(async (request, response) => {
    const body = await readBody(request);
    received.push(body.messages.map((m) => m.content).join("\n"));
    const verdict = { seat: "x", findings: [], overall_verdict: "APPROVE", verdict_reasoning: "looks right", raw_usage: { promptTokens: 1, completionTokens: 1 } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", () => resolve()));
  const previous = process.env.CONCLAVE_XENIA_BASE_URL;
  process.env.CONCLAVE_XENIA_BASE_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  registerFakeSeat("claude", async ({ prompt, cwd }) => {
    if (stepOf(prompt) === "EXECUTE") await writeFile(join(cwd, "src", "feature.ts"), "export const feature = true;\n");
    return approve;
  });
  const reviewer: SeatConfig = { ...fakeSeat("reviewer"), adapter: "xenia", xeniaModel: "test/model" };
  try {
    const result = await runCouncil({ task: "add a feature flag", cwd: dir, dbPath, seats: [fakeSeat("claude"), reviewer] });
    assert.equal(result.approved, true);
  } finally {
    if (previous === undefined) delete process.env.CONCLAVE_XENIA_BASE_URL;
    else process.env.CONCLAVE_XENIA_BASE_URL = previous;
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }

  const planAudit = received.find((text) => stepOf(text) === "PLAN_AUDIT");
  assert.ok(planAudit?.includes("src/index.ts"), "the plan audit shows the repository's files");
  const workAudit = received.find((text) => stepOf(text) === "WORK_AUDIT");
  assert.ok(workAudit?.includes("src/feature.ts"), "the work audit shows the file the executor created");
  assert.ok(workAudit?.includes("+export const feature = true;"), "the work audit includes the actual diff");
});

test("a seat that fails during a ratification vote blocks that vote (a missing vote is never assent), and the next vote proceeds without it", async () => {
  const { dir, dbPath } = await setupRepo("vote-failure");
  let failed = false;
  registerFakeSeat("codex", ({ prompt }) => {
    if (stepOf(prompt) === "RATIFY_WORK" && !failed) {
      failed = true;
      return { kind: "error", message: "provider dropped the connection" };
    }
    return approve;
  });
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  assert.equal(result.approved, true, "the council recovers once the failed seat is out of the electorate");
  const events = readEvents(dbPath, result.sessionId);
  assert.deepEqual(payloads<{ seat: string; phase: string }>(events, "RatificationVoteMissing").map((m) => [m.phase, m.seat]), [["RATIFY_WORK", "codex"]]);
  const workVotes = events.filter((e) => e.type === "PhaseExited" && (e.payload as { phase: string }).phase === "RATIFY_WORK").map((e) => (e.payload as { outcome: string }).outcome);
  // Not ratified, and nobody objected: the council votes again rather than remediating nothing.
  assert.deepEqual(workVotes, ["VOTE_INCOMPLETE", "RATIFIED"], "the vote with a missing ballot must not ratify");
});

test("findings are credited to the seat that returned them, whatever the model wrote, and two seats' ids never collide", async () => {
  const { dir, dbPath } = await setupRepo("attribution");
  const finding = (seat: string) => ({ id: "F1", seat, role: "CORRECTNESS" as const, target: "src/x.ts", category: "style", severity: "NIT" as const, description: "nit", falsifiable_test: null, confidence: 0.5 });
  // Both seats call their finding "F1" and claim to be someone else entirely.
  registerFakeSeat("codex", ({ prompt }) => stepOf(prompt) === "PLAN_AUDIT" ? { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok", findings: [finding("verifier")] } } : approve);
  registerFakeSeat("antigravity", ({ prompt }) => stepOf(prompt) === "PLAN_AUDIT" ? { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok", findings: [finding("plan-reviewer")] } } : approve);
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  const findings = Object.values(getSessionStatus(dbPath, result.sessionId).findings);
  assert.deepEqual(findings.map((f) => [f.id, f.seat]).sort(), [["antigravity:F1", "antigravity"], ["codex:F1", "codex"]]);
});

test("every seat call records the model requested and the model the provider reports answering", async () => {
  const { dir, dbPath } = await setupRepo("models");
  registerFakeSeat("codex", () => ({ kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "ok" }, model: "routed-model-7" }));
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  const invocations = Object.values(getSessionStatus(dbPath, result.sessionId).seatInvocations);
  assert.ok(invocations.filter((i) => i.seat === "codex").every((i) => i.model === "routed-model-7"));
  assert.ok(invocations.filter((i) => i.seat === "claude").every((i) => i.model === undefined), "nothing reported, nothing recorded");
  assert.match(result.report, /## Seats/);
  assert.match(result.report, /codex\): fake seat; answered by routed-model-7/);
});

test("a plain folder (not a git repository) runs on a private snapshot; ratified work is applied to it only on request, and only once", async () => {
  const { mkdir, readFile, stat: statPath } = await import("node:fs/promises");
  const { applySessionChanges } = await import("../../dist/session/autonomousCouncil.js");
  const previous = process.env.CONCLAVE_SNAPSHOT_DIR;
  process.env.CONCLAVE_SNAPSHOT_DIR = await mkdtemp(join(tmpdir(), "conclave-snapshots-"));
  const folder = await mkdtemp(join(tmpdir(), "conclave-plain-council-"));
  const dbPath = join(await mkdtemp(join(tmpdir(), "conclave-plain-db-")), "events.db");
  try {
    await mkdir(join(folder, "src"));
    await writeFile(join(folder, "src", "sum.js"), "export const sum = (a, b) => a - b;\n");
    registerFakeSeat("claude", async ({ prompt, cwd }) => {
      if (stepOf(prompt) === "EXECUTE") await writeFile(join(cwd, "src", "sum.js"), "export const sum = (a, b) => a + b;\n");
      return approve;
    });
    const result = await runCouncil({ task: "fix sum", cwd: folder, dbPath, seats: council() });
    assert.equal(result.approved, true);
    assert.match(result.report, /conclave apply/);
    assert.equal(await readFile(join(folder, "src", "sum.js"), "utf8"), "export const sum = (a, b) => a - b;\n", "the folder is not modified by the council");
    await assert.rejects(() => statPath(join(folder, ".git")), "and never gets a .git");
    const proj = getSessionStatus(dbPath, result.sessionId);
    assert.equal(proj.worktree?.snapshot, true);

    const preview = await applySessionChanges({ dbPath, sessionId: result.sessionId, check: true });
    assert.deepEqual(preview.files, [{ path: "src/sum.js", change: "modified" }]);
    assert.equal(await readFile(join(folder, "src", "sum.js"), "utf8"), "export const sum = (a, b) => a - b;\n", "a check writes nothing");

    await applySessionChanges({ dbPath, sessionId: result.sessionId });
    assert.equal(await readFile(join(folder, "src", "sum.js"), "utf8"), "export const sum = (a, b) => a + b;\n");
    assert.ok(getSessionStatus(dbPath, result.sessionId).applied);
    await assert.rejects(() => applySessionChanges({ dbPath, sessionId: result.sessionId }), /already applied/);
  } finally {
    if (previous === undefined) delete process.env.CONCLAVE_SNAPSHOT_DIR;
    else process.env.CONCLAVE_SNAPSHOT_DIR = previous;
  }
});

test("only ratified snapshot work can be applied; a git-repository session's work stays a branch to merge", async () => {
  const { applySessionChanges } = await import("../../dist/session/autonomousCouncil.js");
  const { dir, dbPath } = await setupRepo("apply-git");
  const result = await runCouncil({ task: "t", cwd: dir, dbPath, seats: council() });
  await assert.rejects(() => applySessionChanges({ dbPath, sessionId: result.sessionId }), /ran on a git repository/);
});
