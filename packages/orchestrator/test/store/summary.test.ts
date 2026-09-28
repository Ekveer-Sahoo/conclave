import assert from "node:assert/strict";
import test from "node:test";
import { projectSession, summarizeDeliberation } from "../../dist/store/projections.js";
import type { EventEnvelope, StoredEvent } from "@conclave/core";

let seq = 0;
const ev = (event: EventEnvelope): StoredEvent => ({
  seq: ++seq,
  sessionId: "s1",
  ts: new Date().toISOString(),
  type: event.type,
  payload: event.payload,
});

const finding = (id: string, severity: "BLOCKER" | "MAJOR" | "MINOR" | "NIT") => ({
  id, seat: "a", role: "CORRECTNESS" as const, target: `t-${id}`, category: "bug",
  severity, description: id, falsifiable_test: null, confidence: 0.8,
});

const summarize = (events: StoredEvent[]) => summarizeDeliberation(projectSession("s1", events));

test("an empty session summarizes to all zeroes rather than undefined", () => {
  const summary = summarize([ev({ type: "SessionCreated", payload: { sessionId: "s1", task: "t", budgetCeilingUsd: 20, minQuorum: 2 } })]);
  assert.deepEqual(summary.findings, { total: 0, addressed: 0, bySeverity: {} });
  assert.deepEqual(summary.contentions, { total: 0, open: 0, escalated: 0, byTerminalState: {} });
  assert.deepEqual(summary.arbitrations, { total: 0, upheld: 0, dismissed: 0, deferred: 0, byHuman: 0 });
  assert.deepEqual(summary.verifications, { total: 0, reproduced: 0, refuted: 0, inconclusive: 0 });
  assert.deepEqual(summary.ratifications, []);
});

test("findings are counted by severity and by whether remediation addressed them", () => {
  const summary = summarize([
    ev({ type: "FindingRecorded", payload: { finding: finding("f1", "BLOCKER"), phase: "WORK_AUDIT", round: 0 } }),
    ev({ type: "FindingRecorded", payload: { finding: finding("f2", "MAJOR"), phase: "WORK_AUDIT", round: 0 } }),
    ev({ type: "FindingRecorded", payload: { finding: finding("f3", "MAJOR"), phase: "WORK_AUDIT", round: 0 } }),
    ev({ type: "FindingAddressed", payload: { findingId: "f2", artifactVersion: 1, resolution: "fixed" } }),
  ]);
  assert.equal(summary.findings.total, 3);
  assert.equal(summary.findings.addressed, 1);
  assert.deepEqual(summary.findings.bySeverity, { BLOCKER: 1, MAJOR: 2 });
});

test("an escalated contention is reported separately from one still awaiting arbitration", () => {
  const open = { targets: ["t"], category: "bug", severity: "BLOCKER" as const, findingIds: ["f1"] };
  const summary = summarize([
    ev({ type: "ContentionOpened", payload: { contentionId: "c1", ...open } }),
    ev({ type: "ContentionOpened", payload: { contentionId: "c2", ...open } }),
    ev({ type: "ContentionOpened", payload: { contentionId: "c3", ...open } }),
    ev({ type: "ContentionResolved", payload: { contentionId: "c1", terminalState: "HUMAN_ARBITRATION" } }),
    ev({ type: "ContentionResolved", payload: { contentionId: "c2", terminalState: "WITHDRAWN" } }),
  ]);
  assert.equal(summary.contentions.total, 3);
  assert.equal(summary.contentions.open, 1, "c3 was never ruled on");
  assert.equal(summary.contentions.escalated, 1, "c1 needs a human");
  assert.deepEqual(summary.contentions.byTerminalState, { HUMAN_ARBITRATION: 1, WITHDRAWN: 1, OPEN: 1 });
});

test("arbitration rulings are tallied by outcome", () => {
  const summary = summarize([
    ev({ type: "ArbitrationRuled", payload: { contentionId: "c1", arbiters: ["b"], ruling: "UPHELD", reasoning: "r" } }),
    ev({ type: "ArbitrationRuled", payload: { contentionId: "c2", arbiters: ["b"], ruling: "DISMISSED", reasoning: "r" } }),
    ev({ type: "ArbitrationRuled", payload: { contentionId: "c3", arbiters: ["b"], ruling: "DEFERRED", reasoning: "r" } }),
  ]);
  assert.deepEqual(summary.arbitrations, { total: 3, upheld: 1, dismissed: 1, deferred: 1, byHuman: 0 });
});

test("ballots are grouped per phase and round, so a re-vote is its own tally", () => {
  const summary = summarize([
    ev({ type: "RatificationCast", payload: { phase: "RATIFY_WORK", round: 0, seat: "a", vote: "REJECT" } }),
    ev({ type: "RatificationCast", payload: { phase: "RATIFY_WORK", round: 0, seat: "b", vote: "APPROVE" } }),
    ev({ type: "RatificationVoteMissing", payload: { phase: "RATIFY_WORK", round: 0, seat: "c", reason: "UNAVAILABLE" } }),
    ev({ type: "RatificationCast", payload: { phase: "RATIFY_WORK", round: 1, seat: "a", vote: "APPROVE" } }),
    ev({ type: "RatificationCast", payload: { phase: "RATIFY_WORK", round: 1, seat: "b", vote: "APPROVE_WITH_CHANGES" } }),
  ]);
  assert.equal(summary.ratifications.length, 2);
  assert.deepEqual(summary.ratifications[0], { phase: "RATIFY_WORK", round: 0, approve: 1, approveWithChanges: 0, reject: 1, missing: 1 });
  assert.deepEqual(summary.ratifications[1], { phase: "RATIFY_WORK", round: 1, approve: 1, approveWithChanges: 1, reject: 0, missing: 0 });
});

test("plan and work ratifications are never merged into one tally", () => {
  const summary = summarize([
    ev({ type: "RatificationCast", payload: { phase: "RATIFY_PLAN", round: 0, seat: "a", vote: "APPROVE" } }),
    ev({ type: "RatificationCast", payload: { phase: "RATIFY_WORK", round: 0, seat: "a", vote: "APPROVE" } }),
  ]);
  assert.deepEqual(summary.ratifications.map((tally) => tally.phase), ["RATIFY_PLAN", "RATIFY_WORK"]);
});
