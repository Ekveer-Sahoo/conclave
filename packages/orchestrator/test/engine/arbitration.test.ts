import assert from "node:assert/strict";
import test from "node:test";
import type { Finding } from "@conclave/core";
import { arbitrate, blocksAdvancement } from "../../dist/engine/arbitration.js";
import type { ContentionCandidate } from "../../dist/engine/contention.js";

const finding = (over: Partial<Finding> & Pick<Finding, "id" | "seat" | "severity">): Finding => ({
  role: "CORRECTNESS",
  target: "src/x.ts",
  category: "bug",
  description: `${over.id}`,
  falsifiable_test: null,
  confidence: 0.9,
  ...over,
});

const contention = (over: Partial<ContentionCandidate> = {}): ContentionCandidate => ({
  contentionId: "c-1",
  targets: ["src/x.ts"],
  category: "bug",
  severity: "MAJOR",
  findingIds: ["f1"],
  claimants: ["a"],
  dissenters: ["b"],
  ...over,
});

const findingMap = (...items: Finding[]) => new Map(items.map((item) => [item.id, item]));

test("a reproduced falsifiable test upholds the claim regardless of how many seats dissent", () => {
  const decision = arbitrate({
    contention: contention({ dissenters: ["b", "c", "d", "e"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "MINOR", confidence: 0.1 })),
    evidence: [{ findingId: "f1", result: "TRUE" }],
    activeSeatIds: new Set(["a", "b", "c", "d", "e"]),
  });
  assert.equal(decision.ruling, "UPHELD");
  assert.equal(decision.terminalState, "ARBITRATED");
  assert.match(decision.reasoning, /executed evidence/);
});

test("a clean sweep of failed reproductions dismisses the claim", () => {
  const decision = arbitrate({
    contention: contention({ findingIds: ["f1", "f2"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "BLOCKER" }), finding({ id: "f2", seat: "a", severity: "BLOCKER" })),
    evidence: [
      { findingId: "f1", result: "FALSE" },
      { findingId: "f2", result: "FALSE" },
    ],
    activeSeatIds: new Set(["a", "b"]),
  });
  assert.equal(decision.ruling, "DISMISSED");
  assert.equal(decision.terminalState, "WITHDRAWN");
});

test("one inconclusive run leaves the question open rather than dismissing it", () => {
  const decision = arbitrate({
    contention: contention({ severity: "BLOCKER", findingIds: ["f1", "f2"], dissenters: ["b", "c"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "BLOCKER" }), finding({ id: "f2", seat: "a", severity: "BLOCKER" })),
    evidence: [
      { findingId: "f1", result: "FALSE" },
      { findingId: "f2", result: "INCONCLUSIVE" },
    ],
    activeSeatIds: new Set(["a", "b", "c"]),
  });
  assert.notEqual(decision.ruling, "DISMISSED");
});

test("a contested BLOCKER is never auto-dismissed — it escalates to a human", () => {
  const decision = arbitrate({
    contention: contention({ severity: "BLOCKER", dissenters: ["b", "c", "d", "e", "f"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "BLOCKER", confidence: 0.2 })),
    evidence: [],
    activeSeatIds: new Set(["a", "b", "c", "d", "e", "f"]),
  });
  assert.equal(decision.ruling, "DEFERRED");
  assert.equal(decision.terminalState, "HUMAN_ARBITRATION");
  assert.equal(blocksAdvancement(decision), true, "an escalated blocker must keep gating advancement");
});

test("a lone low-confidence MINOR against several dissenters is dismissed by weight", () => {
  const decision = arbitrate({
    contention: contention({ severity: "MINOR", dissenters: ["b", "c", "d"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "MINOR", confidence: 0.2 })),
    evidence: [],
    activeSeatIds: new Set(["a", "b", "c", "d"]),
  });
  assert.equal(decision.ruling, "DISMISSED");
  assert.equal(blocksAdvancement(decision), false);
});

test("a confident BLOCKER against a single dissenter is upheld by weight", () => {
  const decision = arbitrate({
    contention: contention({ severity: "BLOCKER" }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "BLOCKER", confidence: 1 })),
    evidence: [],
    activeSeatIds: new Set(["a", "b"]),
  });
  assert.equal(decision.ruling, "UPHELD");
  assert.equal(decision.terminalState, "ACCEPTED");
});

test("arbiters are exactly the seats with no stake in the contested target", () => {
  const decision = arbitrate({
    contention: contention({ claimants: ["a", "b"], dissenters: ["c"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "MAJOR" })),
    evidence: [],
    activeSeatIds: new Set(["a", "b", "c", "d"]),
  });
  assert.deepEqual(decision.arbiters, ["c", "d"], "claimants may not rule on their own claim");
});

test("an inconclusive non-blocking contention is deferred, not silently decided", () => {
  const decision = arbitrate({
    contention: contention({ severity: "MAJOR", dissenters: ["b"] }),
    findings: findingMap(finding({ id: "f1", seat: "a", severity: "MAJOR", confidence: 0.85 })),
    evidence: [],
    activeSeatIds: new Set(["a", "b"]),
  });
  assert.equal(decision.ruling, "DEFERRED");
  assert.equal(decision.terminalState, "DEFERRED");
  assert.equal(blocksAdvancement(decision), true);
});
