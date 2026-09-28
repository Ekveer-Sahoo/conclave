import assert from "node:assert/strict";
import test from "node:test";
import type { Phase } from "@conclave/core";
import { resumeEntry, transition, type PhaseSignal, type TransitionState } from "../../dist/engine/transition.js";

const state = (phase: Phase, round = 0, over: Partial<TransitionState> = {}): TransitionState => ({
  phase,
  round,
  discussionRoundCap: 6,
  remediationRoundCap: 3,
  ...over,
});

const step = (phase: Phase, signal: PhaseSignal, round = 0, over: Partial<TransitionState> = {}) =>
  transition(state(phase, round, over), signal);

const expectAdvance = (phase: Phase, signal: PhaseSignal, toPhase: Phase, toRound = 0, round = 0) => {
  const decision = step(phase, signal, round);
  assert.deepEqual(decision, { kind: "advance", phase: toPhase, round: toRound }, `${phase} + ${signal}`);
};

test("the happy path walks INTAKE through REPORT without revisiting a phase", () => {
  const walked: Phase[] = [];
  const signals: Record<string, PhaseSignal> = {
    INTAKE: "START",
    PLAN: "PLAN_DRAFTED",
    PLAN_AUDIT: "AUDIT_CLEAN",
    RATIFY_PLAN: "RATIFIED",
    EXECUTE: "IMPLEMENTED",
    WORK_AUDIT: "AUDIT_CLEAN",
    RATIFY_WORK: "RATIFIED",
    REPORT: "RATIFIED",
  };
  let current = state("INTAKE");
  for (let guard = 0; guard < 20; guard++) {
    walked.push(current.phase);
    const decision = transition(current, signals[current.phase]);
    if (decision.kind === "terminal") {
      assert.equal(decision.outcome, "APPROVED");
      break;
    }
    current = { ...current, phase: decision.phase, round: decision.round };
  }
  assert.deepEqual(walked, [
    "INTAKE", "PLAN", "PLAN_AUDIT", "RATIFY_PLAN", "EXECUTE", "WORK_AUDIT", "RATIFY_WORK", "REPORT",
  ]);
});

test("a contested plan audit routes to deliberation, a defective one straight to refinement", () => {
  expectAdvance("PLAN_AUDIT", "AUDIT_CONTESTED", "DELIBERATE");
  expectAdvance("PLAN_AUDIT", "AUDIT_DEFECTIVE", "PLAN_REFINE");
  expectAdvance("PLAN_AUDIT", "AUDIT_CLEAN", "RATIFY_PLAN");
});

test("resolved contentions reach ratification; unresolved ones force another plan revision", () => {
  expectAdvance("DELIBERATE", "CONTENTIONS_RESOLVED", "RATIFY_PLAN");
  expectAdvance("DELIBERATE", "CONTENTIONS_UNRESOLVED", "PLAN_REFINE");
});

test("each plan refinement consumes a round and re-audits", () => {
  expectAdvance("PLAN_REFINE", "REFINED_ACTIONABLE", "PLAN_AUDIT", 1, 0);
  expectAdvance("PLAN_REFINE", "REFINED_ACTIONABLE", "PLAN_AUDIT", 3, 2);
});

test("a contested work audit deliberates; a defective one remediates and re-audits", () => {
  expectAdvance("WORK_AUDIT", "AUDIT_CONTESTED", "WORK_REFINE");
  expectAdvance("WORK_AUDIT", "AUDIT_DEFECTIVE", "REMEDIATE", 1);
  expectAdvance("REMEDIATE", "REMEDIATED", "RE_AUDIT", 1, 1);
  expectAdvance("RE_AUDIT", "AUDIT_CLEAN", "RATIFY_WORK", 1, 1);
});

test("work refinement either clears the board or produces remediation work", () => {
  expectAdvance("WORK_REFINE", "REFINED_CLEAN", "RATIFY_WORK");
  expectAdvance("WORK_REFINE", "CONTENTIONS_RESOLVED", "RATIFY_WORK");
  expectAdvance("WORK_REFINE", "REFINED_ACTIONABLE", "REMEDIATE", 1);
  expectAdvance("WORK_REFINE", "CONTENTIONS_UNRESOLVED", "REMEDIATE", 1);
});

test("a failed plan ratification revises the plan until the discussion cap stops it", () => {
  expectAdvance("RATIFY_PLAN", "NOT_RATIFIED", "PLAN_REFINE", 0, 0);
  const capped = step("RATIFY_PLAN", "NOT_RATIFIED", 2, { discussionRoundCap: 3 });
  assert.equal(capped.kind, "terminal");
  assert.equal(capped.kind === "terminal" && capped.outcome, "NOT_APPROVED");
});

test("a failed work ratification refines until the remediation cap stops it", () => {
  expectAdvance("RATIFY_WORK", "NOT_RATIFIED", "WORK_REFINE", 1, 1);
  const capped = step("RATIFY_WORK", "NOT_RATIFIED", 3, { remediationRoundCap: 3 });
  assert.equal(capped.kind, "terminal");
  assert.equal(capped.kind === "terminal" && capped.outcome, "NOT_APPROVED");
});

test("persistent work defects terminate at the remediation cap instead of looping forever", () => {
  const capped = step("RE_AUDIT", "AUDIT_DEFECTIVE", 3, { remediationRoundCap: 3 });
  assert.equal(capped.kind, "terminal");
  assert.equal(capped.kind === "terminal" && capped.outcome, "NOT_APPROVED");
  assert.match(capped.kind === "terminal" ? capped.reason : "", /remediation round/);
});

test("cancellation, fatal error, and budget exhaustion short-circuit from any phase", () => {
  for (const phase of ["PLAN", "EXECUTE", "RE_AUDIT", "RATIFY_WORK"] as Phase[]) {
    assert.equal(step(phase, "CANCELLED").kind === "terminal" && step(phase, "CANCELLED").outcome, "CANCELLED");
    assert.equal(step(phase, "ERRORED").kind === "terminal" && step(phase, "ERRORED").outcome, "ERRORED");
    const budget = step(phase, "BUDGET_EXHAUSTED");
    assert.equal(budget.kind === "terminal" && budget.outcome, "NOT_APPROVED");
    assert.match(budget.kind === "terminal" ? budget.reason : "", /budget ceiling/);
  }
});

test("an unroutable phase/signal pair throws instead of stranding the session", () => {
  assert.throws(() => step("EXECUTE", "AUDIT_CLEAN"), /no transition from EXECUTE/);
  assert.throws(() => step("INTAKE", "RATIFIED"), /no transition from INTAKE/);
});

test("every declared phase is reachable from INTAKE", () => {
  const all: Phase[] = [
    "INTAKE", "PLAN", "PLAN_AUDIT", "PLAN_REFINE", "DELIBERATE", "RATIFY_PLAN", "EXECUTE",
    "WORK_AUDIT", "WORK_REFINE", "REMEDIATE", "RE_AUDIT", "RATIFY_WORK", "REPORT",
  ];
  const everySignal: PhaseSignal[] = [
    "START", "PLAN_DRAFTED", "AUDIT_CLEAN", "AUDIT_CONTESTED", "AUDIT_DEFECTIVE",
    "CONTENTIONS_RESOLVED", "CONTENTIONS_UNRESOLVED", "REFINED_CLEAN", "REFINED_ACTIONABLE",
    "RATIFIED", "NOT_RATIFIED", "IMPLEMENTED", "REMEDIATED",
  ];
  const reached = new Set<Phase>(["INTAKE"]);
  for (let pass = 0; pass < all.length; pass++) {
    for (const phase of [...reached]) {
      for (const signal of everySignal) {
        let decision;
        try {
          decision = transition(state(phase, 0), signal);
        } catch {
          continue; // unroutable pair, as intended
        }
        if (decision.kind === "advance") reached.add(decision.phase);
      }
    }
  }
  assert.deepEqual([...reached].sort(), [...all].sort(), "no phase may be declared but unreachable");
});

test("resume never re-enters a phase that mutates the repository", () => {
  assert.deepEqual(resumeEntry({ phase: "EXECUTE", round: 0, phaseOpen: true }), { phase: "WORK_AUDIT", round: 0 });
  assert.deepEqual(resumeEntry({ phase: "REMEDIATE", round: 2, phaseOpen: true }), { phase: "RE_AUDIT", round: 2 });
  assert.deepEqual(resumeEntry({ phase: "PLAN_REFINE", round: 1, phaseOpen: true }), { phase: "PLAN_AUDIT", round: 1 });
});

test("resume re-verifies rather than trusting an interrupted finalization", () => {
  assert.deepEqual(resumeEntry({ phase: "REPORT", round: 0, phaseOpen: true }), { phase: "WORK_AUDIT", round: 0 });
  assert.deepEqual(resumeEntry({ phase: "RATIFY_WORK", round: 2, phaseOpen: false }), { phase: "RE_AUDIT", round: 2 });
  assert.deepEqual(resumeEntry({ phase: undefined, round: 0, phaseOpen: false }), { phase: "INTAKE", round: 0 });
});

test("a plan ratified but never executed resumes into EXECUTE, not back into the audit", () => {
  assert.deepEqual(
    resumeEntry({ phase: "RATIFY_PLAN", round: 1, phaseOpen: false, lastPhaseOutcome: "ratified" }),
    { phase: "EXECUTE", round: 0 },
  );
  assert.deepEqual(
    resumeEntry({ phase: "RATIFY_PLAN", round: 1, phaseOpen: true, lastPhaseOutcome: "ratified" }),
    { phase: "PLAN_AUDIT", round: 1 },
    "a vote that never closed must be re-taken",
  );
});
