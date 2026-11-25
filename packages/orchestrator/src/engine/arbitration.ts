import type { Finding, Severity } from "@conclave/core";
import type { ContentionCandidate } from "./contention.js";

/**
 * Weight a single claim carries, before confidence scaling. A BLOCKER asserted at full confidence
 * exactly balances two silent approvals (1.0 against 2 × 0.5): too close to call, so on its own it
 * is neither upheld nor dismissed but escalates to a human (see `arbitrate`). A MINOR does not
 * outweigh even one approval.
 */
const SEVERITY_WEIGHT: Record<Severity, number> = { BLOCKER: 1, MAJOR: 0.6, MINOR: 0.25, NIT: 0.1 };
/** What one seat's silent approval of a target is worth against a claim on it. */
const DISSENT_WEIGHT = 0.5;
/** Margin by which one side must beat the other before the policy rules without deferring. */
const DECISIVE_MARGIN = 1.25;

export type ArbitrationRuling = "UPHELD" | "DISMISSED" | "DEFERRED";
export type TerminalState =
  | "ACCEPTED" | "WITHDRAWN" | "SUPERSEDED" | "DEFERRED" | "ARBITRATED" | "HUMAN_ARBITRATION";

export interface VerificationEvidence {
  findingId: string;
  result: "TRUE" | "FALSE" | "INCONCLUSIVE";
}

export interface ArbitrationDecision {
  contentionId: string;
  /** Seats with no stake in this target, which is what makes them fit to rule on it. */
  arbiters: string[];
  ruling: ArbitrationRuling;
  reasoning: string;
  terminalState: TerminalState;
}

export interface ArbitrateInput {
  contention: ContentionCandidate;
  /** Every finding referenced by the contention, keyed by id. */
  findings: Map<string, Finding>;
  /** Verification runs executed against those findings, if any. */
  evidence: VerificationEvidence[];
  activeSeatIds: Set<string>;
}

/**
 * Resolves one contention by deterministic policy rather than by spending another council round on
 * it. Two properties matter more than the exact weights:
 *
 * 1. **Executed evidence beats opinion.** A falsifiable test that actually ran settles the question
 *    outright — no amount of seat agreement overrides a reproduction.
 * 2. **A BLOCKER is never dismissed on a close call.** When the weights are inconclusive, a blocking
 *    claim escalates to HUMAN_ARBITRATION instead of being outvoted into silence. Auto-dismissing a
 *    contested blocker is the one failure mode that would let the council approve unsafe work.
 */
export function arbitrate(input: ArbitrateInput): ArbitrationDecision {
  const { contention, findings, evidence, activeSeatIds } = input;
  const arbiters = [...activeSeatIds]
    .filter((seat) => !contention.claimants.includes(seat))
    .sort();
  const decide = (
    ruling: ArbitrationRuling,
    terminalState: TerminalState,
    reasoning: string,
  ): ArbitrationDecision => ({ contentionId: contention.contentionId, arbiters, ruling, reasoning, terminalState });

  const relevant = evidence.filter((item) => contention.findingIds.includes(item.findingId));
  const proved = relevant.filter((item) => item.result === "TRUE");
  const disproved = relevant.filter((item) => item.result === "FALSE");

  if (proved.length > 0) {
    return decide(
      "UPHELD",
      "ARBITRATED",
      `Upheld on executed evidence: ${proved.length} falsifiable test(s) reproduced the claim (${proved
        .map((item) => item.findingId)
        .join(", ")}).`,
    );
  }
  // Only a clean sweep disproves a contention: every claim in it refuted by a test that ran. One
  // inconclusive run leaves the question open — and so does a claim nobody tested: refuting a
  // tested MAJOR says nothing about an untested BLOCKER on the same file.
  const refutedIds = new Set(disproved.map((item) => item.findingId));
  const inconclusive = relevant.some((item) => item.result === "INCONCLUSIVE" && !refutedIds.has(item.findingId));
  if (disproved.length > 0 && !inconclusive && contention.findingIds.every((findingId) => refutedIds.has(findingId))) {
    return decide(
      "DISMISSED",
      "WITHDRAWN",
      `Dismissed on executed evidence: every falsifiable test for this contention failed to reproduce it (${disproved
        .map((item) => item.findingId)
        .join(", ")}).`,
    );
  }

  const claimWeight = contention.findingIds.reduce((total, findingId) => {
    const finding = findings.get(findingId);
    if (!finding) return total;
    return total + SEVERITY_WEIGHT[finding.severity] * finding.confidence;
  }, 0);
  const dissentWeight = contention.dissenters.length * DISSENT_WEIGHT;
  const detail =
    `claim ${claimWeight.toFixed(2)} (${contention.claimants.join(", ") || "none"}) ` +
    `vs dissent ${dissentWeight.toFixed(2)} (${contention.dissenters.join(", ") || "none"})`;

  if (claimWeight >= dissentWeight * DECISIVE_MARGIN) {
    return decide("UPHELD", "ACCEPTED", `Upheld by weighted policy: ${detail}.`);
  }
  if (dissentWeight >= claimWeight * DECISIVE_MARGIN) {
    if (contention.severity === "BLOCKER") {
      return decide(
        "DEFERRED",
        "HUMAN_ARBITRATION",
        `Dissent outweighs the claim (${detail}), but a BLOCKER is never auto-dismissed: escalating for human arbitration.`,
      );
    }
    return decide("DISMISSED", "WITHDRAWN", `Dismissed by weighted policy: ${detail}.`);
  }
  if (contention.severity === "BLOCKER") {
    return decide(
      "DEFERRED",
      "HUMAN_ARBITRATION",
      `Inconclusive on a BLOCKER (${detail}): escalating for human arbitration rather than guessing.`,
    );
  }
  return decide("DEFERRED", "DEFERRED", `Inconclusive (${detail}): deferred to a later round.`);
}

/** Contentions that still gate advancement: anything upheld or escalated, but not dismissed. */
export const blocksAdvancement = (decision: ArbitrationDecision): boolean =>
  decision.ruling !== "DISMISSED";
