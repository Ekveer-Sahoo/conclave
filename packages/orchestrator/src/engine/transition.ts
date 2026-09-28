import type { Phase } from "@conclave/core";

/**
 * What a phase reports on the way out. Signals describe what *happened*, never where to go next —
 * routing lives entirely in `transition`, so the phase bodies stay ignorant of the graph.
 */
export type PhaseSignal =
  | "START"
  /** A plan draft exists and is ready to be audited. */
  | "PLAN_DRAFTED"
  /** Audit found nothing material: ready to ratify. */
  | "AUDIT_CLEAN"
  /** Audit found material disagreement between seats: needs deliberation. */
  | "AUDIT_CONTESTED"
  /** Audit found material defects every active seat agrees on: needs work, not debate. */
  | "AUDIT_DEFECTIVE"
  /** Deliberation closed every contention. */
  | "CONTENTIONS_RESOLVED"
  /** Deliberation left contentions open (deferred or escalated). */
  | "CONTENTIONS_UNRESOLVED"
  /** A refine phase produced a revised artifact with nothing left to act on. */
  | "REFINED_CLEAN"
  /** A refine phase produced work items that must be implemented. */
  | "REFINED_ACTIONABLE"
  | "RATIFIED"
  | "NOT_RATIFIED"
  | "IMPLEMENTED"
  | "REMEDIATED"
  | "CANCELLED"
  | "ERRORED"
  | "BUDGET_EXHAUSTED";

export interface TransitionState {
  phase: Phase;
  round: number;
  /** Hard ceiling on plan-side audit rounds. */
  discussionRoundCap: number;
  /** Hard ceiling on remediation cycles on the work side. */
  remediationRoundCap: number;
}

export type TransitionDecision =
  | { kind: "advance"; phase: Phase; round: number }
  | {
      kind: "terminal";
      outcome: "APPROVED" | "NOT_APPROVED" | "CANCELLED" | "ERRORED";
      reason: string;
    };

const advance = (phase: Phase, round: number): TransitionDecision => ({ kind: "advance", phase, round });
const terminal = (
  outcome: "APPROVED" | "NOT_APPROVED" | "CANCELLED" | "ERRORED",
  reason: string,
): TransitionDecision => ({ kind: "terminal", outcome, reason });

/**
 * The council's phase graph, as a pure function of (state, signal).
 *
 * Keeping this separate from the session driver is what makes the flow testable without a
 * database, a repository, or a provider: every routing rule below is exercised by calling this
 * function directly. The driver's only job is to run a phase, classify its result into a signal,
 * and append the events for wherever this sends it.
 *
 * Plan side:  INTAKE → PLAN → PLAN_AUDIT ⇄ (DELIBERATE → PLAN_REFINE) → RATIFY_PLAN
 * Work side:  EXECUTE → WORK_AUDIT ⇄ (WORK_REFINE → REMEDIATE → RE_AUDIT) → RATIFY_WORK → REPORT
 */
export function transition(state: TransitionState, signal: PhaseSignal): TransitionDecision {
  // Interrupts short-circuit the graph from any phase.
  if (signal === "CANCELLED") return terminal("CANCELLED", `cancelled during ${state.phase}`);
  if (signal === "ERRORED") return terminal("ERRORED", `fatal error during ${state.phase}`);
  if (signal === "BUDGET_EXHAUSTED") {
    return terminal("NOT_APPROVED", `budget ceiling reached during ${state.phase}`);
  }

  const { phase, round, discussionRoundCap, remediationRoundCap } = state;
  // A plan round is "used" once its audit closes, so the cap compares against round + 1.
  const planRoundsExhausted = round + 1 >= discussionRoundCap;
  const remediationExhausted = round >= remediationRoundCap;

  switch (phase) {
    case "INTAKE":
      if (signal === "START") return advance("PLAN", 0);
      break;

    case "PLAN":
      if (signal === "PLAN_DRAFTED") return advance("PLAN_AUDIT", round);
      break;

    case "PLAN_AUDIT":
      if (signal === "AUDIT_CLEAN") return advance("RATIFY_PLAN", round);
      if (signal === "AUDIT_CONTESTED") return advance("DELIBERATE", round);
      if (signal === "AUDIT_DEFECTIVE") {
        return planRoundsExhausted
          ? terminal("NOT_APPROVED", `plan still defective after ${discussionRoundCap} round(s)`)
          : advance("PLAN_REFINE", round);
      }
      break;

    case "DELIBERATE":
      if (signal === "CONTENTIONS_RESOLVED") return advance("RATIFY_PLAN", round);
      if (signal === "CONTENTIONS_UNRESOLVED") {
        return planRoundsExhausted
          ? terminal(
              "NOT_APPROVED",
              `contentions unresolved after ${discussionRoundCap} deliberation round(s)`,
            )
          : advance("PLAN_REFINE", round);
      }
      break;

    case "PLAN_REFINE":
      if (signal === "REFINED_CLEAN" || signal === "REFINED_ACTIONABLE") {
        return planRoundsExhausted
          ? terminal("NOT_APPROVED", `plan discussion cap of ${discussionRoundCap} round(s) reached`)
          : advance("PLAN_AUDIT", round + 1);
      }
      break;

    case "RATIFY_PLAN":
      if (signal === "RATIFIED") return advance("EXECUTE", 0);
      if (signal === "NOT_RATIFIED") {
        return planRoundsExhausted
          ? terminal("NOT_APPROVED", `plan not ratified within ${discussionRoundCap} round(s)`)
          : advance("PLAN_REFINE", round);
      }
      break;

    case "EXECUTE":
      if (signal === "IMPLEMENTED") return advance("WORK_AUDIT", 0);
      break;

    // WORK_AUDIT and RE_AUDIT are the same decision point; only their labels differ, so that the
    // event log distinguishes a first audit from a post-remediation one.
    case "WORK_AUDIT":
    case "RE_AUDIT":
      if (signal === "AUDIT_CLEAN") return advance("RATIFY_WORK", round);
      if (signal === "AUDIT_CONTESTED") return advance("WORK_REFINE", round);
      if (signal === "AUDIT_DEFECTIVE") {
        return remediationExhausted
          ? terminal(
              "NOT_APPROVED",
              `work still defective after ${remediationRoundCap} remediation round(s)`,
            )
          : advance("REMEDIATE", round + 1);
      }
      break;

    case "WORK_REFINE":
      // Deliberation on the work side either produces something to fix or clears the board.
      if (signal === "REFINED_CLEAN" || signal === "CONTENTIONS_RESOLVED") {
        return advance("RATIFY_WORK", round);
      }
      if (signal === "REFINED_ACTIONABLE" || signal === "CONTENTIONS_UNRESOLVED") {
        return remediationExhausted
          ? terminal(
              "NOT_APPROVED",
              `work contentions unresolved after ${remediationRoundCap} remediation round(s)`,
            )
          : advance("REMEDIATE", round + 1);
      }
      break;

    case "REMEDIATE":
      if (signal === "REMEDIATED") return advance("RE_AUDIT", round);
      break;

    case "RATIFY_WORK":
      if (signal === "RATIFIED") return advance("REPORT", round);
      if (signal === "NOT_RATIFIED") {
        return remediationExhausted
          ? terminal("NOT_APPROVED", `work not ratified within ${remediationRoundCap} round(s)`)
          : advance("WORK_REFINE", round);
      }
      break;

    case "REPORT":
      return terminal("APPROVED", "council ratified the work");
  }

  // An unroutable (phase, signal) pair is a bug in the driver, not a council outcome — fail loudly
  // rather than silently parking the session in a phase it can never leave.
  throw new Error(`no transition from ${phase} on signal ${signal}`);
}

/**
 * Where a resumed session re-enters the graph, given the last durable phase boundary.
 *
 * The rule is conservative on purpose: re-entry always lands on a phase that *reads* state rather
 * than one that mutates it, so a resume can never double-apply an edit whose completion was not
 * durably recorded. An interrupted EXECUTE resumes into WORK_AUDIT, not back into EXECUTE.
 */
export function resumeEntry(state: {
  phase?: Phase;
  round: number;
  phaseOpen: boolean;
  lastPhaseOutcome?: string;
}): { phase: Phase; round: number } {
  const { phase, round, phaseOpen } = state;
  if (!phase) return { phase: "INTAKE", round: 0 };

  switch (phase) {
    case "INTAKE":
    case "PLAN":
      return { phase: "PLAN", round: 0 };

    case "PLAN_AUDIT":
    case "DELIBERATE":
    case "PLAN_REFINE":
      // Mid-round → redo that round. Between rounds → the next one.
      return { phase: "PLAN_AUDIT", round: phaseOpen ? round : round };

    case "RATIFY_PLAN":
      // A ratification that never closed must be re-taken; one that closed as ratified still
      // re-audits, because EXECUTE's completion was not durably recorded either way.
      return phaseOpen || state.lastPhaseOutcome !== "ratified"
        ? { phase: "PLAN_AUDIT", round }
        : { phase: "EXECUTE", round: 0 };

    case "EXECUTE":
      // Never re-run EXECUTE: inspect whatever it managed to write instead.
      return { phase: "WORK_AUDIT", round: 0 };

    case "WORK_AUDIT":
    case "WORK_REFINE":
    case "RE_AUDIT":
      return { phase: round === 0 ? "WORK_AUDIT" : "RE_AUDIT", round };

    case "REMEDIATE":
      // Same reasoning as EXECUTE: re-audit the tree rather than re-applying a partial fix.
      return { phase: "RE_AUDIT", round };

    case "RATIFY_WORK":
    case "REPORT":
    default:
      // Finalization was interrupted: re-verify from a fresh audit before approving anything.
      return { phase: round === 0 ? "WORK_AUDIT" : "RE_AUDIT", round };
  }
}
