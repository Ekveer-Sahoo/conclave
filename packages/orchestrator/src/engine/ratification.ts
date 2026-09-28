import type { Severity } from "@conclave/core";
import { isMaterial } from "./contention.js";

export type Vote = "APPROVE" | "APPROVE_WITH_CHANGES" | "REJECT";
export type MissingReason = "UNAVAILABLE" | "MALFORMED";

export interface CastVote { seat: string; vote: Vote }
export interface MissingVote { seat: string; reason: MissingReason }

export interface RatificationTally {
  ratified: boolean;
  approvals: number;
  conditional: number;
  rejections: number;
  missing: number;
  /** Seats eligible to vote at the moment of the tally. */
  electorate: number;
  requiredQuorum: number;
  reason: string;
}

export interface TallyInput {
  votes: CastVote[];
  missing: MissingVote[];
  activeSeatIds: Set<string>;
  minQuorum: number;
  /** Severities of contentions still open when the vote closed. */
  openContentionSeverities: Severity[];
}

/**
 * Tallies a RATIFY_PLAN or RATIFY_WORK vote.
 *
 * Ratification is deliberately stricter than a majority: every active seat must cast a vote and
 * none may reject. The reason is that a seat going silent is indistinguishable from a seat whose
 * objection was lost, so counting a missing vote as assent would let an outage approve work. A
 * non-quorate vote is reported as such rather than resolved either way.
 *
 * APPROVE_WITH_CHANGES is genuine approval only when nothing material is still open — otherwise
 * "approve, but fix this first" would be recorded as unconditional approval of unfixed work.
 */
export function tallyRatification(input: TallyInput): RatificationTally {
  const electorate = input.activeSeatIds.size;
  const requiredQuorum = Math.max(1, Math.min(input.minQuorum, electorate));

  // Last vote per seat wins, so a re-cast in the same round corrects rather than duplicates.
  const bySeat = new Map<string, Vote>();
  for (const cast of input.votes) {
    if (input.activeSeatIds.has(cast.seat)) bySeat.set(cast.seat, cast.vote);
  }
  const counted = [...bySeat.values()];
  const approvals = counted.filter((vote) => vote === "APPROVE").length;
  const conditional = counted.filter((vote) => vote === "APPROVE_WITH_CHANGES").length;
  const rejections = counted.filter((vote) => vote === "REJECT").length;
  const missing = input.missing.filter(
    (item) => input.activeSeatIds.has(item.seat) && !bySeat.has(item.seat),
  ).length;

  const base = { approvals, conditional, rejections, missing, electorate, requiredQuorum };
  const deny = (reason: string): RatificationTally => ({ ...base, ratified: false, reason });

  if (electorate === 0) return deny("no active seats remain: nothing to ratify");
  if (counted.length < requiredQuorum) {
    return deny(`quorum not met: ${counted.length} of ${requiredQuorum} required votes cast`);
  }
  if (counted.length < electorate) {
    return deny(
      `${electorate - counted.length} active seat(s) did not vote; a missing vote is never counted as assent`,
    );
  }
  if (rejections > 0) return deny(`${rejections} seat(s) voted REJECT`);

  const materialOpen = input.openContentionSeverities.filter(isMaterial).length;
  if (materialOpen > 0) {
    return deny(`${materialOpen} material contention(s) still open`);
  }
  if (conditional > 0 && input.openContentionSeverities.length > 0) {
    return deny(
      `${conditional} conditional approval(s) with ${input.openContentionSeverities.length} contention(s) still open`,
    );
  }
  return {
    ...base,
    ratified: true,
    reason:
      conditional > 0
        ? `ratified: ${approvals} approve, ${conditional} approve-with-changes, no open contentions`
        : `ratified unanimously by ${approvals} active seat(s)`,
  };
}
