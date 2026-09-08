import {
  ArbitrationRuledEvent,
  ArtifactWrittenEvent,
  ContentionOpenedEvent,
  ContentionResolvedEvent,
  FindingAddressedEvent,
  RatificationCastEvent,
  RatificationVoteMissingEvent,
  SeatInvokedEvent,
  ThreadMessageAddedEvent,
  VerificationRunEvent,
  WorktreeCreatedEvent,
  WorktreeKeptEvent,
  WorktreeRemovedEvent,
  type Finding,
  type Phase,
  type StoredEvent,
  type Verdict,
} from "@conclave/core";
import type { z } from "zod";

type Payload<TSchema extends z.ZodTypeAny> = z.infer<TSchema> extends { payload: infer TPayload }
  ? TPayload
  : never;
type WorktreeCreated = Payload<typeof WorktreeCreatedEvent>;
type WorktreeRemoved = Payload<typeof WorktreeRemovedEvent>;
type WorktreeKept = Payload<typeof WorktreeKeptEvent>;
type FindingAddressed = Payload<typeof FindingAddressedEvent>;
type ContentionOpened = Payload<typeof ContentionOpenedEvent>;
type ContentionResolved = Payload<typeof ContentionResolvedEvent>;
type ThreadMessageAdded = Payload<typeof ThreadMessageAddedEvent>;
type SeatInvoked = Payload<typeof SeatInvokedEvent>;
type VerificationRun = Payload<typeof VerificationRunEvent>;
type ArbitrationRuled = Payload<typeof ArbitrationRuledEvent>;
type RatificationCast = Payload<typeof RatificationCastEvent>;
type RatificationVoteMissing = Payload<typeof RatificationVoteMissingEvent>;
type ArtifactWritten = Payload<typeof ArtifactWrittenEvent>;

type Worktree = WorktreeCreated & {
  treeHashes: Partial<Record<"before" | "after", string>>;
};
type FindingProjection = Finding & {
  addressed?: Pick<FindingAddressed, "artifactVersion" | "resolution">;
};
type ContentionProjection = {
  status: "OPEN" | ContentionResolved["terminalState"];
  targets: ContentionOpened["targets"];
  category: ContentionOpened["category"];
  severity: ContentionOpened["severity"];
  findingIds: ContentionOpened["findingIds"];
  thread: Array<Pick<ThreadMessageAdded, "author" | "stance" | "reasoning" | "evidence">>;
};
type SeatInvocationProjection = Pick<SeatInvoked, "seat" | "phase" | "round" | "status"> & {
  verdict?: Verdict;
};
type VerificationProjection = VerificationRun;
type ArbitrationProjection = Omit<ArbitrationRuled, "contentionId">;
type RatificationProjection =
  | RatificationCast
  | (Omit<RatificationVoteMissing, "reason"> & {
      missingReason: RatificationVoteMissing["reason"];
    });
type ArtifactProjection = ArtifactWritten;

export interface SessionProjection {
  sessionId: string;
  task?: string;
  budgetCeilingUsd?: number;
  minQuorum?: number;
  currentPhase?: Phase;
  currentRound: number;
  worktree?: Worktree;
  worktreeRemoved?: WorktreeRemoved;
  worktreeKept?: WorktreeKept;
  lastPhaseOutcome?: string;
  spentUsd: number;
  seatInvocations: Record<string, SeatInvocationProjection>;
  findings: Record<string, FindingProjection>;
  contentions: Record<string, ContentionProjection>;
  verifications: VerificationProjection[];
  arbitrations: Record<string, ArbitrationProjection>;
  ratifications: RatificationProjection[];
  artifacts: ArtifactProjection[];
  errored: boolean;
  fatalError?: string;
}

/** Rebuilds session state purely by folding over the append-only event log — never read from anywhere else. */
export function projectSession(sessionId: string, events: StoredEvent[]): SessionProjection {
  const proj: SessionProjection = {
    sessionId,
    currentRound: 0,
    spentUsd: 0,
    seatInvocations: {},
    findings: {},
    contentions: {},
    verifications: [],
    arbitrations: {},
    ratifications: [],
    artifacts: [],
    errored: false,
  };

  const contention = (contentionId: string): ContentionProjection => {
    const existing = proj.contentions[contentionId];
    if (existing) return existing;

    return (proj.contentions[contentionId] = {
      status: "OPEN",
      targets: [],
      category: "",
      severity: "NIT",
      findingIds: [],
      thread: [],
    });
  };

  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case "SessionCreated":
        proj.task = p.task as string;
        proj.budgetCeilingUsd = p.budgetCeilingUsd as number;
        proj.minQuorum = p.minQuorum as number;
        break;
      case "WorktreeCreated":
        proj.worktree = {
          baseCommit: p.baseCommit as string,
          branch: p.branch as string,
          path: p.path as string,
          treeHashes: {},
        };
        break;
      case "WorktreeTreeHashRecorded":
        if (proj.worktree) {
          proj.worktree.treeHashes[p.stage as "before" | "after"] = p.hash as string;
        }
        break;
      case "WorktreeRemoved":
        proj.worktreeRemoved = { reason: p.reason as string };
        break;
      case "WorktreeKept":
        proj.worktreeKept = { reason: p.reason as string };
        break;
      case "PhaseEntered":
        proj.currentPhase = p.phase as Phase;
        proj.currentRound = p.round as number;
        break;
      case "PhaseExited":
        proj.lastPhaseOutcome = p.outcome as string;
        break;
      case "SeatInvoked":
        proj.seatInvocations[p.correlationId as string] = {
          seat: p.seat as string,
          phase: p.phase as Phase,
          round: p.round as number,
          status: p.status as SeatInvocationProjection["status"],
          verdict: p.verdict as Verdict | undefined,
        };
        break;
      case "FindingRecorded": {
        const f = p.finding as Finding;
        proj.findings[f.id] = f;
        break;
      }
      case "FindingAddressed": {
        const finding = proj.findings[p.findingId as string];
        if (finding) {
          finding.addressed = {
            artifactVersion: p.artifactVersion as number,
            resolution: p.resolution as string,
          };
        }
        break;
      }
      case "ContentionOpened": {
        const opened = contention(p.contentionId as string);
        opened.targets = p.targets as string[];
        opened.category = p.category as string;
        opened.severity = p.severity as ContentionProjection["severity"];
        opened.findingIds = p.findingIds as string[];
        break;
      }
      case "ThreadMessageAdded":
        contention(p.contentionId as string).thread.push({
          author: p.author as string,
          stance: p.stance as ThreadMessageAdded["stance"],
          reasoning: p.reasoning as string,
          evidence: p.evidence as string[],
        });
        break;
      case "VerificationRun":
        proj.verifications.push({
          contentionId: p.contentionId as string | undefined,
          findingId: p.findingId as string,
          command: p.command as string,
          result: p.result as VerificationProjection["result"],
          output: p.output as string,
        });
        break;
      case "ArbitrationRuled":
        proj.arbitrations[p.contentionId as string] = {
          arbiters: p.arbiters as string[],
          ruling: p.ruling as string,
          reasoning: p.reasoning as string,
        };
        break;
      case "RatificationCast":
        proj.ratifications.push({
          phase: p.phase as RatificationCast["phase"],
          round: p.round as number,
          seat: p.seat as string,
          vote: p.vote as RatificationCast["vote"],
          citedContentionId: p.citedContentionId as string | undefined,
        });
        break;
      case "RatificationVoteMissing":
        proj.ratifications.push({
          phase: p.phase as RatificationVoteMissing["phase"],
          round: p.round as number,
          seat: p.seat as string,
          missingReason: p.reason as RatificationVoteMissing["reason"],
        });
        break;
      case "ContentionResolved":
        contention(p.contentionId as string).status = p.terminalState as ContentionProjection["status"];
        break;
      case "ArtifactWritten":
        proj.artifacts.push({
          kind: p.kind as ArtifactProjection["kind"],
          version: p.version as number,
          hash: p.hash as string,
          path: p.path as string,
        });
        break;
      case "BudgetSpent":
        proj.spentUsd += p.costUsd as number;
        break;
      case "SessionErrored":
        proj.errored = true;
        if (p.fatal) proj.fatalError = p.message as string;
        break;
    }
  }

  return proj;
}
