import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore, newSessionId } from "../../src/store/eventStore.ts";
import { projectSession } from "../../src/store/projections.ts";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `conclave-eventstore-${newSessionId()}.db`);
}

test("append assigns increasing seq numbers and echoes the stored event", () => {
  const store = new EventStore(":memory:");
  const sessionId = "session-append";

  const first = store.append(sessionId, {
    type: "SessionCreated",
    payload: { sessionId, task: "Ship Conclave", budgetCeilingUsd: 5, minQuorum: 3 },
  });
  const second = store.append(sessionId, {
    type: "PhaseEntered",
    payload: { phase: "PLAN", round: 0 },
  });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(second.sessionId, sessionId);
  assert.equal(second.type, "PhaseEntered");
  assert.deepEqual(second.payload, { phase: "PLAN", round: 0 });
  assert.ok(new Date(second.ts).toISOString() === second.ts);

  store.close();
});

test("append rejects an event that fails schema validation", () => {
  const store = new EventStore(":memory:");

  assert.throws(() => {
    store.append("session-invalid", {
      // @ts-expect-error deliberately malformed for the test
      type: "PhaseEntered",
      payload: { phase: "NOT_A_REAL_PHASE", round: 0 },
    });
  });

  store.close();
});

test("replay returns events for a session in seq order and ignores other sessions", () => {
  const store = new EventStore(":memory:");

  store.append("session-a", {
    type: "SessionCreated",
    payload: { sessionId: "session-a", task: "A", budgetCeilingUsd: 5, minQuorum: 3 },
  });
  store.append("session-b", {
    type: "SessionCreated",
    payload: { sessionId: "session-b", task: "B", budgetCeilingUsd: 5, minQuorum: 3 },
  });
  store.append("session-a", { type: "PhaseEntered", payload: { phase: "PLAN", round: 0 } });
  store.append("session-a", { type: "PhaseExited", payload: { phase: "PLAN", round: 0, outcome: "advance" } });

  const replayed = store.replay("session-a");

  assert.equal(replayed.length, 3);
  assert.deepEqual(
    replayed.map((e) => e.type),
    ["SessionCreated", "PhaseEntered", "PhaseExited"]
  );
  assert.deepEqual(
    replayed.map((e) => e.seq),
    [1, 3, 4]
  );
  assert.ok(replayed.every((e) => e.sessionId === "session-a"));

  store.close();
});

test("listSessions returns every distinct session id in the log", () => {
  const store = new EventStore(":memory:");

  store.append("session-a", {
    type: "SessionCreated",
    payload: { sessionId: "session-a", task: "A", budgetCeilingUsd: 5, minQuorum: 3 },
  });
  store.append("session-b", {
    type: "SessionCreated",
    payload: { sessionId: "session-b", task: "B", budgetCeilingUsd: 5, minQuorum: 3 },
  });

  // Most-recently-active session first, so session-history UIs surface newest sessions up top.
  assert.deepEqual(store.listSessions(), ["session-b", "session-a"]);

  store.close();
});

test("listSessions pages with limit/offset over most-recently-active order", () => {
  const store = new EventStore(":memory:");
  for (const id of ["s1", "s2", "s3"]) {
    store.append(id, { type: "SessionCreated", payload: { sessionId: id, task: id, budgetCeilingUsd: 5, minQuorum: 3 } });
  }
  assert.deepEqual(store.listSessions(2, 0), ["s3", "s2"]);
  assert.deepEqual(store.listSessions(2, 2), ["s1"]);
  store.close();
});

test("replaySince returns only events strictly after the given seq, capped at limit", () => {
  const store = new EventStore(":memory:");
  store.append("s1", { type: "SessionCreated", payload: { sessionId: "s1", task: "t", budgetCeilingUsd: 5, minQuorum: 3 } });
  store.append("s1", { type: "UserMessagePosted", payload: { text: "hi" } });
  store.append("s1", { type: "UserMessagePosted", payload: { text: "again" } });
  const all = store.replay("s1");
  const firstSeq = all[0]!.seq;

  const since = store.replaySince("s1", firstSeq);
  assert.equal(since.length, 2);
  assert.deepEqual(
    since.map((e) => e.type),
    ["UserMessagePosted", "UserMessagePosted"],
  );

  const capped = store.replaySince("s1", 0, 1);
  assert.equal(capped.length, 1);
  assert.equal(capped[0]!.seq, all[0]!.seq);

  store.close();
});

test("events survive being reopened from the same on-disk database path", () => {
  const dbPath = tmpDbPath();
  const sessionId = "session-persist";

  try {
    const writer = new EventStore(dbPath);
    writer.append(sessionId, {
      type: "SessionCreated",
      payload: { sessionId, task: "Persisted", budgetCeilingUsd: 5, minQuorum: 3 },
    });
    writer.append(sessionId, { type: "PhaseEntered", payload: { phase: "PLAN", round: 0 } });
    writer.close();

    const reader = new EventStore(dbPath);
    const replayed = reader.replay(sessionId);
    reader.close();

    assert.equal(replayed.length, 2);
    assert.deepEqual(
      replayed.map((e) => e.type),
      ["SessionCreated", "PhaseEntered"]
    );
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

test("replaying the log and re-running projectSession reproduces the same final projection", () => {
  const store = new EventStore(":memory:");
  const sessionId = "session-replay-projection";

  store.append(sessionId, {
    type: "SessionCreated",
    payload: { sessionId, task: "Ship Conclave", budgetCeilingUsd: 5, minQuorum: 3 },
  });
  store.append(sessionId, { type: "PhaseEntered", payload: { phase: "PLAN", round: 0 } });
  store.append(sessionId, {
    type: "SeatInvoked",
    payload: {
      correlationId: "call-ok",
      seat: "gemini",
      phase: "PLAN",
      round: 0,
      status: "OK",
      verdict: {
        seat: "gemini",
        findings: [],
        overall_verdict: "APPROVE",
        verdict_reasoning: "Looks good.",
        raw_usage: { promptTokens: 10, completionTokens: 5 },
      },
    },
  });
  store.append(sessionId, { type: "PhaseExited", payload: { phase: "PLAN", round: 0, outcome: "advance" } });

  const liveProjection = projectSession(sessionId, store.replay(sessionId));
  const replayedAgainProjection = projectSession(sessionId, store.replay(sessionId));

  assert.deepEqual(replayedAgainProjection, liveProjection);
  assert.equal(liveProjection.currentPhase, "PLAN");
  assert.equal(liveProjection.lastPhaseOutcome, "advance");
  assert.equal(liveProjection.seatInvocations["call-ok"]?.verdict?.overall_verdict, "APPROVE");

  store.close();
});

test("usageSince treats a BudgetSpent with no authoritative usage as zero, never NaN (which would disable spend limits)", () => {
  const store = new EventStore(":memory:");
  const base = { phase: "PLAN_AUDIT" as const, round: 0, latencyMs: 5 };
  store.append("s1", { type: "BudgetSpent", payload: { ...base, correlationId: "a", seat: "codex", usageAvailable: true, promptTokens: 100, completionTokens: 50, costUsd: 0.25, costSource: "local_estimate" } });
  store.append("s1", { type: "BudgetSpent", payload: { ...base, correlationId: "b", seat: "codex", usageAvailable: false, costSource: "unavailable" } });
  store.append("s1", { type: "BudgetSpent", payload: { ...base, correlationId: "c", usageAvailable: false, costSource: "unavailable" } });
  const usage = store.usageSince("1970-01-01T00:00:00.000Z");
  const total = usage.reduce((sum, seat) => sum + seat.costUsd, 0);
  assert.ok(Number.isFinite(total));
  assert.equal(total, 0.25);
  assert.deepEqual(usage.find((seat) => seat.seat === "codex"), { seat: "codex", promptTokens: 100, completionTokens: 50, costUsd: 0.25 });
  store.close();
});
