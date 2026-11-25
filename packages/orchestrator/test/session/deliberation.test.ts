import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { SeatConfig, StoredEvent } from "@conclave/core";
import { runCouncil } from "../../dist/session/autonomousCouncil.js";
import { EventStore } from "../../src/store/eventStore.ts";

const execFileAsync = promisify(execFile);
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
}

const seatCfg = (id: string, provider: string): SeatConfig => ({
  id, label: id, adapter: "cli", cliCommand: process.execPath, cliArgsTemplate: [provider, id, "{prompt}"],
  role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 10_000, enabled: true, tier: "standard",
});

const payloads = <T>(events: StoredEvent[], type: string): T[] =>
  events.filter((event) => event.type === type).map((event) => event.payload as T);
const phasesOf = (events: StoredEvent[]) =>
  payloads<{ phase: string }>(events, "PhaseEntered").map((payload) => payload.phase);

async function setup(prefix: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), `conclave-${prefix}-`));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), `conclave-${prefix}-scratch-`));
  const provider = join(scratch, "provider.mjs");
  const marker = join(scratch, "marker");
  await writeFile(provider, script);
  const seats = ["claude", "codex", "antigravity"].map((id) => seatCfg(id, provider));
  return { dir, scratch, provider, marker, seats, dbPath: join(scratch, "events.db") };
}

test("one seat objecting where the others approve opens a contention, arbitrates it, and revises the plan", async () => {
  const ctx = await setup("deliberate", `
import { existsSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const prompt = process.argv[3] || "";
const marker = process.env.CONCLAVE_TEST_MARKER;
const usage = { promptTokens: 1, completionTokens: 2 };
// codex objects to the FIRST plan audit only; everyone else always approves. After the plan is
// revised, codex approves too, so the session can reach a verdict.
if (id === "codex" && prompt.includes("Audit the implementation plan") && !existsSync(marker)) {
  writeFileSync(marker, "1");
  console.log(JSON.stringify({
    seat: id,
    findings: [{ id: "f-auth", seat: id, role: "SECURITY", target: "src/auth.ts", category: "authz", severity: "BLOCKER", description: "the plan skips authorization entirely", falsifiable_test: null, confidence: 0.9 }],
    overall_verdict: "REJECT",
    verdict_reasoning: "the plan omits authorization",
    raw_usage: usage,
  }));
} else {
  console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: usage }));
}
`);
  const previous = process.env.CONCLAVE_TEST_MARKER;
  process.env.CONCLAVE_TEST_MARKER = ctx.marker;
  try {
    const result = await runCouncil({ task: "test", cwd: ctx.dir, dbPath: ctx.dbPath, seats: ctx.seats });
    assert.equal(result.approved, true, "the council should still reach a verdict after resolving the dispute");

    const store = new EventStore(ctx.dbPath);
    const events = store.replay(result.sessionId);
    store.close();

    // One genuine dispute: codex objected where claude and antigravity approved.
    const opened = payloads<{ targets: string[]; severity: string; findingIds: string[] }>(events, "ContentionOpened");
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].targets, ["src/auth.ts"]);
    assert.equal(opened[0].severity, "BLOCKER");
    // Finding ids are namespaced by the seat that filed them, so two seats' ids can never collide.
    assert.deepEqual(opened[0].findingIds, ["codex:f-auth"]);

    // Both sides of the argument are durably recorded before the ruling.
    const thread = payloads<{ author: string; stance: string }>(events, "ThreadMessageAdded");
    assert.equal(thread.length, 3);
    assert.deepEqual(thread.filter((m) => m.stance === "DISSENT").map((m) => m.author), ["codex"]);
    assert.deepEqual(thread.filter((m) => m.stance === "REJECT").map((m) => m.author).sort(), ["antigravity", "claude"]);

    // A contested BLOCKER is escalated, never quietly outvoted by the two approving seats.
    const rulings = payloads<{ ruling: string; arbiters: string[] }>(events, "ArbitrationRuled");
    assert.equal(rulings.length, 1);
    assert.equal(rulings[0].ruling, "DEFERRED");
    assert.deepEqual(rulings[0].arbiters.sort(), ["antigravity", "claude"], "the objecting seat may not rule on its own claim");
    // Escalated first; then, once the revised plan's audit no longer raises it, closed as superseded
    // rather than left parked in HUMAN_ARBITRATION on a session the council went on to ratify.
    assert.deepEqual(payloads<{ terminalState: string }>(events, "ContentionResolved").map((r) => r.terminalState), ["HUMAN_ARBITRATION", "SUPERSEDED"]);
    assert.deepEqual(payloads<{ outcome: string }>(events, "SessionConcluded").map((c) => c.outcome), ["APPROVED"]);

    // The dispute forced a real detour through deliberation and plan revision.
    const phases = phasesOf(events);
    assert.ok(phases.includes("DELIBERATE"), `expected a DELIBERATE phase, got ${phases.join(" → ")}`);
    assert.ok(phases.includes("PLAN_REFINE"), `expected a PLAN_REFINE phase, got ${phases.join(" → ")}`);
    assert.equal(phases.filter((phase) => phase === "PLAN_AUDIT").length, 2, "the revised plan must be re-audited");
    // Two plan versions were written: the original and the revision.
    assert.equal(payloads<{ kind: string }>(events, "ArtifactWritten").filter((a) => a.kind === "plan").length, 2);
    assert.equal(phases.at(-1), "REPORT");
  } finally {
    if (previous === undefined) delete process.env.CONCLAVE_TEST_MARKER;
    else process.env.CONCLAVE_TEST_MARKER = previous;
  }
});

test("a defect every seat agrees on skips deliberation and goes straight to remediation", async () => {
  const ctx = await setup("remediate", `
import { existsSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const prompt = process.argv[3] || "";
const marker = process.env.CONCLAVE_TEST_MARKER;
const usage = { promptTokens: 1, completionTokens: 2 };
// The executor writes the marker when it remediates; before that, every seat reports the same
// defect on the same target, so the council agrees rather than disputing.
if (prompt.includes("Repair and improve")) {
  writeFileSync(marker, "1");
  console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "fixed", raw_usage: usage }));
} else if (prompt.includes("Audit the actual current state") && !existsSync(marker)) {
  console.log(JSON.stringify({
    seat: id,
    findings: [{ id: "f-" + id, seat: id, role: "CORRECTNESS", target: "src/handler.ts", category: "bug", severity: "MAJOR", description: "unhandled error path", falsifiable_test: null, confidence: 0.9 }],
    overall_verdict: "REJECT",
    verdict_reasoning: "the error path is unhandled",
    raw_usage: usage,
  }));
} else {
  console.log(JSON.stringify({ seat: id, findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: usage }));
}
`);
  const previous = process.env.CONCLAVE_TEST_MARKER;
  process.env.CONCLAVE_TEST_MARKER = ctx.marker;
  try {
    const result = await runCouncil({ task: "test", cwd: ctx.dir, dbPath: ctx.dbPath, seats: ctx.seats });
    assert.equal(result.approved, true);

    const store = new EventStore(ctx.dbPath);
    const events = store.replay(result.sessionId);
    store.close();

    assert.equal(events.some((event) => event.type === "ContentionOpened"), false, "unanimous agreement is not a dispute and must not be arbitrated");
    assert.equal(events.some((event) => event.type === "ArbitrationRuled"), false);

    const phases = phasesOf(events);
    assert.ok(phases.includes("REMEDIATE"), `expected a REMEDIATE phase, got ${phases.join(" → ")}`);
    assert.ok(phases.includes("RE_AUDIT"), `expected a RE_AUDIT phase, got ${phases.join(" → ")}`);
    assert.equal(phases.includes("WORK_REFINE"), false, "there was nothing to deliberate");

    // Each seat's finding is recorded as addressed by the remediation that fixed it.
    const addressed = payloads<{ findingId: string }>(events, "FindingAddressed");
    assert.deepEqual(addressed.map((a) => a.findingId).sort(), ["antigravity:f-antigravity", "claude:f-claude", "codex:f-codex"]);
    assert.equal(phases.at(-1), "REPORT");
  } finally {
    if (previous === undefined) delete process.env.CONCLAVE_TEST_MARKER;
    else process.env.CONCLAVE_TEST_MARKER = previous;
  }
});
