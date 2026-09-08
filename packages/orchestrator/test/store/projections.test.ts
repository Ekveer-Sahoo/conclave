import assert from "node:assert/strict";
import test from "node:test";
import { EventEnvelopeSchema, type StoredEvent } from "@conclave/core";
import { projectSession } from "../../src/store/projections.ts";

const sessionId = "session-projection";

const events: StoredEvent[] = [
  ["SessionCreated", { sessionId, task: "Ship Conclave", budgetCeilingUsd: 5, minQuorum: 3 }],
  ["WorktreeCreated", { baseCommit: "abc123", branch: "conclave/session-projection", path: "/tmp/conclave" }],
  ["WorktreeTreeHashRecorded", { phase: "PLAN", stage: "before", hash: "tree-before" }],
  ["WorktreeTreeHashRecorded", { phase: "PLAN", stage: "after", hash: "tree-after" }],
  ["PhaseEntered", { phase: "PLAN_AUDIT", round: 2 }],
  ["PhaseExited", { phase: "PLAN_AUDIT", round: 2, outcome: "refine" }],
  [
    "SeatInvoked",
    {
      correlationId: "call-ok",
      seat: "gemini",
      phase: "PLAN_AUDIT",
      round: 2,
      status: "OK",
      verdict: {
        seat: "gemini",
        findings: [],
        overall_verdict: "APPROVE",
        verdict_reasoning: "Looks good.",
        raw_usage: { promptTokens: 10, completionTokens: 5 },
      },
    },
  ],
  ["SeatInvoked", { correlationId: "call-down", seat: "grok", phase: "PLAN_AUDIT", round: 2, status: "UNAVAILABLE" }],
  [
    "FindingRecorded",
    {
      phase: "PLAN_AUDIT",
      round: 2,
      finding: {
        id: "finding-1",
        seat: "gemini",
        role: "CORRECTNESS",
        target: "src/index.ts:4",
        category: "CORRECTNESS",
        severity: "MAJOR",
        description: "Missing guard.",
        falsifiable_test: "npm test -- guard",
        confidence: 0.9,
      },
    },
  ],
  ["FindingAddressed", { findingId: "finding-1", artifactVersion: 2, resolution: "Added the guard." }],
  [
    "ContentionOpened",
    {
      contentionId: "contention-1",
      targets: ["src/index.ts:4"],
      category: "CORRECTNESS",
      severity: "MAJOR",
      findingIds: ["finding-1"],
    },
  ],
  [
    "ThreadMessageAdded",
    {
      contentionId: "contention-1",
      author: "Claude",
      stance: "ACCEPT",
      reasoning: "The guard is required.",
      evidence: ["src/index.ts:4"],
    },
  ],
  [
    "VerificationRun",
    {
      contentionId: "contention-1",
      findingId: "finding-1",
      command: "npm test -- guard",
      result: "TRUE",
      output: "passing",
    },
  ],
  [
    "ArbitrationRuled",
    { contentionId: "contention-1", arbiters: ["kimi"], ruling: "Add guard.", reasoning: "Safer." },
  ],
  [
    "RatificationCast",
    { phase: "RATIFY_PLAN", round: 0, seat: "gemini", vote: "APPROVE", citedContentionId: "contention-1" },
  ],
  ["RatificationVoteMissing", { phase: "RATIFY_PLAN", round: 0, seat: "grok", reason: "UNAVAILABLE" }],
  ["ContentionResolved", { contentionId: "contention-1", terminalState: "ARBITRATED" }],
  ["ArtifactWritten", { kind: "plan", version: 2, hash: "plan-hash", path: "/tmp/plan.md" }],
  [
    "BudgetSpent",
    {
      correlationId: "call-ok",
      seat: "gemini",
      phase: "PLAN_AUDIT",
      round: 2,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.25,
      costSource: "xenia_authoritative",
      latencyMs: 100,
    },
  ],
  ["SessionErrored", { message: "recoverable", fatal: false }],
  ["SessionErrored", { message: "fatal", fatal: true }],
  ["WorktreeKept", { reason: "User requested inspection." }],
  ["WorktreeRemoved", { reason: "Cleanup complete." }],
].map(([type, payload], index) => {
  const event = EventEnvelopeSchema.parse({ type, payload });
  return { seq: index + 1, sessionId, ts: `2026-09-05T00:00:${String(index).padStart(2, "0")}Z`, ...event };
});

test("projectSession folds every event type", () => {
  const projection = projectSession(sessionId, events);

  assert.equal(projection.task, "Ship Conclave");
  assert.equal(projection.currentPhase, "PLAN_AUDIT");
  assert.equal(projection.currentRound, 2);
  assert.equal(projection.lastPhaseOutcome, "refine");
  assert.deepEqual(projection.worktree, {
    baseCommit: "abc123",
    branch: "conclave/session-projection",
    path: "/tmp/conclave",
    treeHashes: { before: "tree-before", after: "tree-after" },
  });
  assert.deepEqual(projection.worktreeKept, { reason: "User requested inspection." });
  assert.deepEqual(projection.worktreeRemoved, { reason: "Cleanup complete." });

  assert.equal(projection.seatInvocations["call-ok"]?.verdict?.overall_verdict, "APPROVE");
  assert.equal(projection.seatInvocations["call-down"]?.status, "UNAVAILABLE");
  assert.deepEqual(projection.findings["finding-1"]?.addressed, {
    artifactVersion: 2,
    resolution: "Added the guard.",
  });
  assert.deepEqual(projection.contentions["contention-1"], {
    status: "ARBITRATED",
    targets: ["src/index.ts:4"],
    category: "CORRECTNESS",
    severity: "MAJOR",
    findingIds: ["finding-1"],
    thread: [{ author: "Claude", stance: "ACCEPT", reasoning: "The guard is required.", evidence: ["src/index.ts:4"] }],
  });
  assert.deepEqual(projection.verifications, [
    {
      contentionId: "contention-1",
      findingId: "finding-1",
      command: "npm test -- guard",
      result: "TRUE",
      output: "passing",
    },
  ]);
  assert.deepEqual(projection.arbitrations["contention-1"], {
    arbiters: ["kimi"],
    ruling: "Add guard.",
    reasoning: "Safer.",
  });
  assert.deepEqual(projection.ratifications, [
    { phase: "RATIFY_PLAN", round: 0, seat: "gemini", vote: "APPROVE", citedContentionId: "contention-1" },
    { phase: "RATIFY_PLAN", round: 0, seat: "grok", missingReason: "UNAVAILABLE" },
  ]);
  assert.deepEqual(projection.artifacts, [{ kind: "plan", version: 2, hash: "plan-hash", path: "/tmp/plan.md" }]);
  assert.equal(projection.spentUsd, 0.25);
  assert.equal(projection.errored, true);
  assert.equal(projection.fatalError, "fatal");
});
