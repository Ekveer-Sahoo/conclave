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

  assert.deepEqual(store.listSessions(), ["session-a", "session-b"]);

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
