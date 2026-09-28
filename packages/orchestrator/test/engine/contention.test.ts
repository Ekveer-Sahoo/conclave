import assert from "node:assert/strict";
import test from "node:test";
import type { Finding, Severity, Verdict } from "@conclave/core";
import { detectContentions, contentionIdFor, uncontestedDefects, OVERALL_TARGET } from "../../dist/engine/contention.js";

const finding = (over: Partial<Finding> & Pick<Finding, "id" | "seat" | "target" | "severity">): Finding => ({
  role: "CORRECTNESS",
  category: "bug",
  description: `${over.id} description`,
  falsifiable_test: null,
  confidence: 0.8,
  ...over,
});

const verdict = (seat: string, overall: Verdict["overall_verdict"], findings: Finding[] = []): Verdict => ({
  seat,
  findings,
  overall_verdict: overall,
  verdict_reasoning: `${seat} says ${overall}`,
  raw_usage: { promptTokens: 1, completionTokens: 1 },
});

const active = (...ids: string[]) => new Set(ids);

test("a material finding one seat raises and another silently approves is a contention", () => {
  const contentions = detectContentions({
    verdicts: [
      verdict("a", "REJECT", [finding({ id: "f1", seat: "a", target: "src/auth.ts", severity: "BLOCKER" })]),
      verdict("b", "APPROVE"),
    ],
    activeSeatIds: active("a", "b"),
  });
  assert.equal(contentions.length, 1);
  assert.deepEqual(contentions[0].targets, ["src/auth.ts"]);
  assert.deepEqual(contentions[0].claimants, ["a"]);
  assert.deepEqual(contentions[0].dissenters, ["b"]);
  assert.equal(contentions[0].severity, "BLOCKER");
});

test("a defect every active seat agrees on is NOT a contention — it needs work, not debate", () => {
  const input = {
    verdicts: [
      verdict("a", "REJECT", [finding({ id: "f1", seat: "a", target: "src/auth.ts", severity: "BLOCKER" })]),
      verdict("b", "REJECT", [finding({ id: "f2", seat: "b", target: "src/auth.ts", severity: "MAJOR" })]),
    ],
    activeSeatIds: active("a", "b"),
  };
  assert.deepEqual(detectContentions(input), []);
  assert.deepEqual(uncontestedDefects(input).map((f) => f.id), ["f1", "f2"]);
});

test("a seat that files the same target as a NIT is dissenting, not agreeing", () => {
  const contentions = detectContentions({
    verdicts: [
      verdict("a", "REJECT", [finding({ id: "f1", seat: "a", target: "src/x.ts", severity: "BLOCKER" })]),
      verdict("b", "APPROVE", [finding({ id: "f2", seat: "b", target: "src/x.ts", severity: "NIT" })]),
    ],
    activeSeatIds: active("a", "b"),
  });
  assert.equal(contentions.length, 1);
  assert.deepEqual(contentions[0].dissenters, ["b"], "downplaying a target is disagreement about materiality");
  assert.deepEqual(contentions[0].findingIds, ["f1"], "only material findings belong to the contention");
});

test("MINOR and NIT disagreements never open a contention", () => {
  assert.deepEqual(
    detectContentions({
      verdicts: [
        verdict("a", "APPROVE_WITH_CHANGES", [finding({ id: "f1", seat: "a", target: "src/x.ts", severity: "MINOR" })]),
        verdict("b", "APPROVE"),
      ],
      activeSeatIds: active("a", "b"),
    }),
    [],
  );
});

test("a bare REJECT with no findings still dissents instead of vanishing", () => {
  const contentions = detectContentions({
    verdicts: [verdict("a", "REJECT"), verdict("b", "APPROVE"), verdict("c", "APPROVE")],
    activeSeatIds: active("a", "b", "c"),
  });
  assert.equal(contentions.length, 1);
  assert.deepEqual(contentions[0].targets, [OVERALL_TARGET]);
  assert.equal(contentions[0].severity, "BLOCKER");
  assert.deepEqual(contentions[0].dissenters, ["b", "c"]);
});

test("verdicts from seats outside the active set are ignored entirely", () => {
  assert.deepEqual(
    detectContentions({
      verdicts: [
        verdict("dropped", "REJECT", [finding({ id: "f1", seat: "dropped", target: "src/x.ts", severity: "BLOCKER" })]),
        verdict("b", "APPROVE"),
      ],
      activeSeatIds: active("b"),
    }),
    [],
  );
});

test("contention ids are derived from the target, so re-detecting the same dispute is stable", () => {
  const detect = () =>
    detectContentions({
      verdicts: [
        verdict("a", "REJECT", [finding({ id: "f1", seat: "a", target: "src/auth.ts", severity: "MAJOR" })]),
        verdict("b", "APPROVE"),
      ],
      activeSeatIds: active("a", "b"),
    })[0].contentionId;
  assert.equal(detect(), detect());
  assert.equal(detect(), contentionIdFor("src/auth.ts"));
  assert.notEqual(contentionIdFor("src/auth.ts"), contentionIdFor("src/other.ts"));
});

test("severity of a contention is the worst severity claimed on that target", () => {
  const contentions = detectContentions({
    verdicts: [
      verdict("a", "REJECT", [finding({ id: "f1", seat: "a", target: "t", severity: "MAJOR" })]),
      verdict("b", "REJECT", [finding({ id: "f2", seat: "b", target: "t", severity: "BLOCKER" })]),
      verdict("c", "APPROVE"),
    ],
    activeSeatIds: active("a", "b", "c"),
  });
  assert.equal(contentions[0].severity, "BLOCKER");
  assert.deepEqual(contentions[0].claimants, ["a", "b"]);
  assert.deepEqual(contentions[0].dissenters, ["c"]);
});

test("a seat that rejects for its own reasons is not a dissenter on someone else's target", () => {
  // Nobody is defending disputed.ts here — b rejected too, just for a different reason. Counting a
  // fellow rejecter as dissent would manufacture a dispute out of two seats that both want changes.
  const input = {
    verdicts: [
      verdict("a", "REJECT", [
        finding({ id: "only-a", seat: "a", target: "disputed.ts", severity: "BLOCKER" }),
        finding({ id: "agreed-a", seat: "a", target: "shared.ts", severity: "MAJOR" }),
      ]),
      verdict("b", "REJECT", [finding({ id: "agreed-b", seat: "b", target: "shared.ts", severity: "MAJOR" })]),
    ],
    activeSeatIds: active("a", "b"),
  };
  assert.deepEqual(detectContentions(input), [], "two rejecting seats disagree with the work, not with each other");
  assert.deepEqual(
    uncontestedDefects(input).map((f) => f.id),
    ["agreed-a", "agreed-b", "only-a"],
    "every material finding becomes work to do",
  );
});

test("the same target becomes contested as soon as one seat approves over it", () => {
  const input = {
    verdicts: [
      verdict("a", "REJECT", [
        finding({ id: "only-a", seat: "a", target: "disputed.ts", severity: "BLOCKER" }),
        finding({ id: "agreed-a", seat: "a", target: "shared.ts", severity: "MAJOR" }),
      ]),
      verdict("b", "APPROVE", [finding({ id: "agreed-b", seat: "b", target: "shared.ts", severity: "MAJOR" })]),
    ],
    activeSeatIds: active("a", "b"),
  };
  assert.deepEqual(
    detectContentions(input).map((c) => c.targets[0]),
    ["disputed.ts"],
    "b approved while a filed a blocker on disputed.ts — that is a real dispute",
  );
  assert.deepEqual(
    uncontestedDefects(input).map((f) => f.id),
    ["agreed-a", "agreed-b"],
    "shared.ts stays an agreed defect and is excluded from the contested set",
  );
});
