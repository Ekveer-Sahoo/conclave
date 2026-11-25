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
    "CommandVerificationRun",
    {
      correlationId: "cmd-1",
      seat: "claude",
      phase: "WORK_AUDIT",
      round: 0,
      command: "node --test",
      result: "PASS",
      exitCode: 0,
      output: "# pass 12",
      findingId: "finding-1",
    },
  ],
  [
    "CommandVerificationRun",
    {
      correlationId: "cmd-2",
      seat: "claude",
      phase: "WORK_AUDIT",
      round: 0,
      command: "git status",
      result: "DENIED",
      output: "permission denied",
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
  ["SessionConcluded", { outcome: "NOT_APPROVED", reason: "plan not ratified within 3 round(s)" }],
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
      seat: undefined,
      findingId: "finding-1",
      command: "npm test -- guard",
      result: "TRUE",
      output: "passing",
    },
  ]);
  assert.deepEqual(projection.commandVerifications, [
    {
      correlationId: "cmd-1",
      seat: "claude",
      phase: "WORK_AUDIT",
      round: 0,
      command: "node --test",
      result: "PASS",
      exitCode: 0,
      output: "# pass 12",
      findingId: "finding-1",
    },
    {
      correlationId: "cmd-2",
      seat: "claude",
      phase: "WORK_AUDIT",
      round: 0,
      command: "git status",
      result: "DENIED",
      exitCode: undefined,
      output: "permission denied",
      findingId: undefined,
    },
  ]);
  assert.deepEqual(projection.arbitrations["contention-1"], {
    arbiters: ["kimi"],
    ruling: "Add guard.",
    reasoning: "Safer.",
    // Events written before rulings carried a source are, by construction, policy rulings.
    source: "policy",
  });
  // No RATIFY_* PhaseEntered precedes these votes in the fixture, so they belong to ballot 0.
  assert.deepEqual(projection.ratifications, [
    { phase: "RATIFY_PLAN", round: 0, seat: "gemini", vote: "APPROVE", citedContentionId: "contention-1", ballot: 0 },
    { phase: "RATIFY_PLAN", round: 0, seat: "grok", missingReason: "UNAVAILABLE", ballot: 0 },
  ]);
  assert.deepEqual(projection.artifacts, [{ kind: "plan", version: 2, hash: "plan-hash", path: "/tmp/plan.md" }]);
  assert.equal(projection.spentUsd, 0.25);
  assert.equal(projection.errored, true);
  assert.equal(projection.fatalError, "fatal");
  assert.equal(projection.outcome, "NOT_APPROVED");
  assert.equal(projection.outcomeReason, "plan not ratified within 3 round(s)");
  assert.equal(projection.planVersion, 2);
});

test("a finding a model credited to a made-up seat is attributed to the seat whose call recorded it (older logs)", () => {
  const seat = (id: string) => ({ id, label: id, adapter: "cli" as const, cliCommand: id, role: "CORRECTNESS" as const, temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard" as const });
  const finding = { id: "F1", seat: "verifier", role: "CORRECTNESS" as const, target: "src/sum.js", category: "bug", severity: "BLOCKER" as const, description: "d", falsifiable_test: null, confidence: 0.9 };
  const events = [
    ["SessionConfigured", { configVersion: 1, repoPath: "/r", seats: [seat("claude"), seat("codex")], discussionRoundCap: 6, remediationRoundCap: 3, budgetCeilingUsd: 5, allowDirtySource: false }],
    ["SeatInvoked", { correlationId: "x", seat: "codex", phase: "RATIFY_PLAN", round: 0, status: "OK" }],
    ["FindingRecorded", { finding, phase: "RATIFY_PLAN", round: 0 }],
  ].map(([type, payload], index) => ({ seq: index + 1, sessionId: "s", ts: "2026-09-28T00:00:00Z", ...EventEnvelopeSchema.parse({ type, payload }) }));
  assert.equal(projectSession("s", events).findings.F1.seat, "codex");
});
