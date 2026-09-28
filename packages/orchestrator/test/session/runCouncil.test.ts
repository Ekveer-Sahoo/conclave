import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { SeatConfig } from "@conclave/core";
import { runCouncil } from "../../dist/session/autonomousCouncil.js";
import { EventStore } from "../../src/store/eventStore.ts";

const execFileAsync = promisify(execFile);
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
}

test("requires three unanimous seats, executes, audits, and persists outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-council-"));
  await initRepo(dir);
  // Test scaffolding (the fake provider script, the event db) lives outside the repo under test
  // so the repo stays clean — a dirty source repo is refused before execution ever starts.
  const scratch = await mkdtemp(join(tmpdir(), "conclave-council-scratch-"));
  const provider = join(scratch, "provider.mjs");
  await writeFile(provider, `
const id = process.argv[2];
console.log(JSON.stringify({seat:id,findings:[],overall_verdict:"APPROVE",verdict_reasoning:"ok",raw_usage:{promptTokens:1,completionTokens:2}}));
`);
  const seat = (id: string): SeatConfig => ({ id, label: id, adapter: "cli", cliCommand: process.execPath, cliArgsTemplate: [provider, id, "{prompt}"], role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 5_000, enabled: true, tier: "standard" });
  const dbPath = join(scratch, "events.db");
  const result = await runCouncil({ task: "test", cwd: dir, dbPath, seats: [seat("claude"), seat("codex"), seat("antigravity")] });
  assert.equal(result.approved, true);
  const store = new EventStore(dbPath);
  const events = store.replay(result.sessionId);
  store.close();

  // A clean unanimous run walks the full graph once, with no deliberation or remediation cycle.
  const phases = events
    .filter((event) => event.type === "PhaseEntered")
    .map((event) => (event.payload as { phase: string }).phase);
  assert.deepEqual(phases, [
    "INTAKE", "PLAN", "PLAN_AUDIT", "RATIFY_PLAN", "EXECUTE", "WORK_AUDIT", "RATIFY_WORK", "REPORT",
  ]);
  // Every entered phase also closed: nothing was left open on a successful run.
  assert.equal(events.filter((event) => event.type === "PhaseExited").length, phases.length);

  // Four fan-out phases across three seats, plus PLAN and EXECUTE on the executor seat alone.
  assert.equal(events.filter((event) => event.type === "SeatInvoked").length, 14);
  assert.equal(events.filter((event) => event.type === "BudgetSpent").length, 14);

  // Both ratification votes were recorded as formal ballots, one per seat.
  const ballots = events.filter((event) => event.type === "RatificationCast");
  assert.equal(ballots.length, 6);
  assert.deepEqual(
    [...new Set(ballots.map((event) => (event.payload as { phase: string }).phase))].sort(),
    ["RATIFY_PLAN", "RATIFY_WORK"],
  );
  assert.equal(events.some((event) => event.type === "RatificationVoteMissing"), false);

  // Unanimous approval leaves nothing to arbitrate.
  assert.equal(events.some((event) => event.type === "ContentionOpened"), false);

  // The plan is a durable artifact, not just prompt text.
  assert.equal(
    events.filter((event) => event.type === "ArtifactWritten" && (event.payload as { kind: string }).kind === "plan").length,
    1,
  );
  // The outcome is the last lifecycle event; the worktree is removed (branch kept) just before it.
  const lifecycle = events.filter((event) => event.type !== "ActivityLogged").map((event) => event.type);
  assert.deepEqual(lifecycle.slice(-2), ["WorktreeRemoved", "SessionConcluded"]);
  assert.deepEqual(events.find((event) => event.type === "SessionConcluded")?.payload, { outcome: "APPROVED", reason: "council ratified the work" });
});

test("records a fatal session error when unanimity cannot be reached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-quorum-"));
  await initRepo(dir);
  const seat = (id: string): SeatConfig => ({ id, label: id, adapter: "cli", cliCommand: process.execPath, cliArgsTemplate: ["--definitely-invalid"], role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 5_000, enabled: true, tier: "standard" });
  const dbPath = join(dir, "events.db");
  const result = await runCouncil({ task: "test", cwd: dir, dbPath, seats: [seat("claude"), seat("codex"), seat("antigravity")], discussionRoundCap: 1 });
  assert.equal(result.approved, false);
  const store = new EventStore(dbPath);
  const events = store.replay(result.sessionId);
  store.close();
  // The terminal lifecycle event is the last thing that happens structurally; a durable
  // ActivityLogged(report) entry may trail it since the report is generated after the outcome
  // is decided, so check the last *lifecycle* event rather than the literal last event.
  assert.equal(
    events.filter((event) => event.type !== "ActivityLogged").at(-1)?.type,
    "SessionErrored",
  );
});

test("cancelling a running session preserves the worktree and records SessionCancelled, never SessionErrored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-cancel-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-cancel-scratch-"));
  const provider = join(scratch, "hang.mjs");
  await writeFile(provider, `setInterval(() => {}, 1000);\n`);
  const seat = (id: string): SeatConfig => ({ id, label: id, adapter: "cli", cliCommand: process.execPath, cliArgsTemplate: [provider], role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 30_000, enabled: true, tier: "standard" });
  const dbPath = join(scratch, "events.db");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("test cancellation")), 300);
  const result = await runCouncil({ task: "test", cwd: dir, dbPath, seats: [seat("claude"), seat("codex"), seat("antigravity")], signal: controller.signal });
  assert.equal(result.approved, false);
  const store = new EventStore(dbPath);
  const events = store.replay(result.sessionId);
  store.close();
  assert.equal(
    events.filter((event) => event.type !== "ActivityLogged").at(-1)?.type,
    "SessionCancelled",
  );
  assert.equal(events.some((event) => event.type === "SessionErrored"), false, "cancellation must not also be recorded as a fatal error");
  const kept = events.find((event) => event.type === "WorktreeKept");
  assert.ok(kept, "worktree must be kept, not removed, when a session is cancelled mid-flight");
  const created = events.find((event) => event.type === "WorktreeCreated");
  assert.ok(created);
  await assert.doesNotReject(() => stat((created!.payload as { path: string }).path), "cancelled session's worktree must still be on disk for inspection");

  const sourceStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir });
  assert.equal(sourceStatus.stdout.trim(), "", "source checkout must remain untouched by a cancelled session");
});
