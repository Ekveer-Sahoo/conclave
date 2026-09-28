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
  CommandVerificationRunEvent,
  WorktreeCreatedEvent,
  WorktreeKeptEvent,
  WorktreeRemovedEvent,
  SessionConfiguredEvent,
  SessionResumedEvent,
  SessionConcludedEvent,
  type Finding,
  type Phase,
  type SeatConfig,
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
type CommandVerificationRun = Payload<typeof CommandVerificationRunEvent>;
type ArbitrationRuled = Payload<typeof ArbitrationRuledEvent>;
type RatificationCast = Payload<typeof RatificationCastEvent>;
type RatificationVoteMissing = Payload<typeof RatificationVoteMissingEvent>;
type ArtifactWritten = Payload<typeof ArtifactWrittenEvent>;
type SessionConfigured = Payload<typeof SessionConfiguredEvent>;
type SessionResumed = Payload<typeof SessionResumedEvent>;
type SessionConcluded = Payload<typeof SessionConcludedEvent>;

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
type CommandVerificationProjection = CommandVerificationRun;
type ArbitrationProjection = Omit<ArbitrationRuled, "contentionId">;
export type SessionOutcome = SessionConcluded["outcome"];
type RatificationProjection =
  | RatificationCast
  | (Omit<RatificationVoteMissing, "reason"> & {
      missingReason: RatificationVoteMissing["reason"];
    });
type ArtifactProjection = ArtifactWritten;
type ResumeProjection = SessionResumed & { ts?: string };

export interface SessionProjection {
  sessionId: string;
  task?: string;
  budgetCeilingUsd?: number;
  minQuorum?: number;
  configVersion?: number;
  repoPath?: string;
  seats?: SeatConfig[];
  discussionRoundCap?: number;
  remediationRoundCap?: number;
  allowDirtySource?: boolean;
  currentPhase?: Phase;
  currentRound: number;
  phaseOpen: boolean;
  worktree?: Worktree;
  worktreeRemoved?: WorktreeRemoved;
  worktreeKept?: WorktreeKept;
  lastPhaseOutcome?: string;
  /** The council's verdict, once one is reached. Cleared by a resume. */
  outcome?: SessionOutcome;
  outcomeReason?: string;
  /**
   * The current implementation plan, as the executor last wrote it (PLAN or PLAN_REFINE). Kept in
   * the projection rather than read back from the plan artifact file, so a resume can restore it
   * from the event log alone even if the artifact directory is gone.
   */
  planText?: string;
  planVersion: number;
  spentUsd: number;
  resumes: ResumeProjection[];
  seatInvocations: Record<string, SeatInvocationProjection>;
  findings: Record<string, FindingProjection>;
  contentions: Record<string, ContentionProjection>;
  verifications: VerificationProjection[];
  commandVerifications: CommandVerificationProjection[];
  arbitrations: Record<string, ArbitrationProjection>;
  ratifications: RatificationProjection[];
  artifacts: ArtifactProjection[];
  errored: boolean;
  fatalError?: string;
  cancelled: boolean;
  cancelReason?: string;
}

/** Rebuilds session state purely by folding over the append-only event log — never read from anywhere else. */
export function projectSession(sessionId: string, events: StoredEvent[]): SessionProjection {
  const proj: SessionProjection = {
    sessionId,
    currentRound: 0,
    planVersion: 0,
    spentUsd: 0,
    seatInvocations: {},
    findings: {},
    contentions: {},
    verifications: [],
    commandVerifications: [],
    arbitrations: {},
    ratifications: [],
    artifacts: [],
    errored: false,
    cancelled: false,
    phaseOpen: false,
    resumes: [],
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
      case "SessionConfigured":
        proj.configVersion = p.configVersion as number;
        proj.repoPath = p.repoPath as string;
        proj.seats = p.seats as SeatConfig[];
        proj.discussionRoundCap = p.discussionRoundCap as number;
        proj.remediationRoundCap = p.remediationRoundCap as number;
        proj.budgetCeilingUsd = p.budgetCeilingUsd as number;
        proj.allowDirtySource = p.allowDirtySource as boolean;
        break;
      case "SessionResumed":
        proj.resumes.push({
          fromPhase: p.fromPhase as Phase | undefined,
          fromRound: p.fromRound as number | undefined,
          reason: p.reason as string,
          ts: ev.ts,
        });
        proj.cancelled = false;
        proj.cancelReason = undefined;
        proj.errored = false;
        proj.fatalError = undefined;
        proj.outcome = undefined;
        proj.outcomeReason = undefined;
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
        proj.phaseOpen = true;
        break;
      case "PhaseExited":
        proj.lastPhaseOutcome = p.outcome as string;
        if (proj.currentPhase === (p.phase as Phase) && proj.currentRound === (p.round as number)) {
          proj.phaseOpen = false;
        }
        break;
      case "SeatInvoked":
        proj.seatInvocations[p.correlationId as string] = {
          seat: p.seat as string,
          phase: p.phase as Phase,
          round: p.round as number,
          status: p.status as SeatInvocationProjection["status"],
          verdict: p.verdict as Verdict | undefined,
        };
        if ((p.phase === "PLAN" || p.phase === "PLAN_REFINE") && p.status === "OK" && p.verdict) {
          proj.planText = (p.verdict as Verdict).verdict_reasoning;
        }
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
        // Contention ids are derived from the target, so the same dispute re-detected in a later
        // round reopens the existing record rather than leaving its previous ruling in place.
        opened.status = "OPEN";
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
      case "CommandVerificationRun":
        proj.commandVerifications.push({
          correlationId: p.correlationId as string,
          seat: p.seat as string,
          phase: p.phase as Phase,
          round: p.round as number,
          command: p.command as string,
          result: p.result as CommandVerificationProjection["result"],
          exitCode: p.exitCode as number | undefined,
          output: p.output as string,
          findingId: p.findingId as string | undefined,
        });
        break;
      case "ArbitrationRuled":
        proj.arbitrations[p.contentionId as string] = {
          arbiters: p.arbiters as string[],
          ruling: p.ruling as string,
          reasoning: p.reasoning as string,
          source: (p.source as ArbitrationProjection["source"] | undefined) ?? "policy",
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
        if (p.kind === "plan") proj.planVersion = Math.max(proj.planVersion, p.version as number);
        break;
      case "BudgetSpent":
        if (typeof p.costUsd === "number") proj.spentUsd += p.costUsd;
        break;
      case "SessionErrored":
        proj.errored = true;
        if (p.fatal) proj.fatalError = p.message as string;
        break;
      case "SessionCancelled":
        proj.cancelled = true;
        proj.cancelReason = p.reason as string;
        break;
      case "SessionConcluded":
        proj.outcome = p.outcome as SessionOutcome;
        proj.outcomeReason = p.reason as string;
        break;
    }
  }

  return proj;
}

/**
 * Condensed view of a session's deliberative state, for the CLI's `status` output and the web
 * UI's session list. Derived purely from the projection, so it needs no extra event replay and
 * can never disagree with the full state it summarizes.
 */
export interface DeliberationSummary {
  findings: { total: number; addressed: number; bySeverity: Record<string, number> };
  contentions: {
    total: number;
    /** Still open: arbitration has not ruled on them at all. */
    open: number;
    /** Ruled on, but escalated to a human rather than decided — these still gate approval. */
    escalated: number;
    byTerminalState: Record<string, number>;
  };
  arbitrations: { total: number; upheld: number; dismissed: number; deferred: number; byHuman: number };
  /** Falsifiable tests a seat actually executed during deliberation, by what they showed. */
  verifications: { total: number; reproduced: number; refuted: number; inconclusive: number };
  ratifications: Array<{
    phase: string;
    round: number;
    approve: number;
    approveWithChanges: number;
    reject: number;
    missing: number;
  }>;
}

export function summarizeDeliberation(proj: SessionProjection): DeliberationSummary {
  const findings = Object.values(proj.findings);
  const bySeverity: Record<string, number> = {};
  for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;

  const contentions = Object.values(proj.contentions);
  const byTerminalState: Record<string, number> = {};
  for (const contention of contentions) {
    byTerminalState[contention.status] = (byTerminalState[contention.status] ?? 0) + 1;
  }

  const rulings = Object.values(proj.arbitrations);
  const countRuling = (name: string) => rulings.filter((ruling) => ruling.ruling === name).length;

  // Ballots are grouped by (phase, round) so a re-vote in a later round reads as its own tally
  // rather than being summed into the earlier one.
  const tallies = new Map<string, DeliberationSummary["ratifications"][number]>();
  for (const entry of proj.ratifications) {
    const key = `${entry.phase}#${entry.round}`;
    const tally = tallies.get(key) ?? { phase: entry.phase, round: entry.round, approve: 0, approveWithChanges: 0, reject: 0, missing: 0 };
    if ("missingReason" in entry) tally.missing += 1;
    else if (entry.vote === "APPROVE") tally.approve += 1;
    else if (entry.vote === "APPROVE_WITH_CHANGES") tally.approveWithChanges += 1;
    else tally.reject += 1;
    tallies.set(key, tally);
  }

  return {
    findings: {
      total: findings.length,
      addressed: findings.filter((finding) => finding.addressed).length,
      bySeverity,
    },
    contentions: {
      total: contentions.length,
      open: contentions.filter((contention) => contention.status === "OPEN").length,
      escalated: contentions.filter((contention) => contention.status === "HUMAN_ARBITRATION").length,
      byTerminalState,
    },
    arbitrations: {
      total: rulings.length,
      upheld: countRuling("UPHELD"),
      dismissed: countRuling("DISMISSED"),
      deferred: countRuling("DEFERRED"),
      byHuman: rulings.filter((ruling) => ruling.source === "human").length,
    },
    verifications: {
      total: proj.verifications.length,
      reproduced: proj.verifications.filter((run) => run.result === "TRUE").length,
      refuted: proj.verifications.filter((run) => run.result === "FALSE").length,
      inconclusive: proj.verifications.filter((run) => run.result === "INCONCLUSIVE").length,
    },
    ratifications: [...tallies.values()],
  };
}

/** A contention the deterministic policy escalated and no human has ruled on yet. */
export interface PendingHumanRuling {
  contentionId: string;
  targets: string[];
  category: string;
  severity: string;
  reasoning?: string;
  thread: ContentionProjection["thread"];
}

/**
 * Contentions currently parked in HUMAN_ARBITRATION. A human ruling appends a ContentionResolved
 * that moves the contention out of that state, so this list empties exactly as rulings land.
 */
export function pendingHumanRulings(proj: SessionProjection): PendingHumanRuling[] {
  return Object.entries(proj.contentions)
    .filter(([, contention]) => contention.status === "HUMAN_ARBITRATION")
    .map(([contentionId, contention]) => ({
      contentionId,
      targets: contention.targets,
      category: contention.category,
      severity: contention.severity,
      reasoning: proj.arbitrations[contentionId]?.reasoning,
      thread: contention.thread,
    }));
}

/**
 * Human rulings that settled a contention, keyed by contention id. Later rounds consult this so a
 * dispute a human already decided is never re-arbitrated (or re-escalated) by policy.
 */
export function humanRulings(proj: SessionProjection): Map<string, { ruling: string; reasoning: string; targets: string[] }> {
  const rulings = new Map<string, { ruling: string; reasoning: string; targets: string[] }>();
  for (const [contentionId, arbitration] of Object.entries(proj.arbitrations)) {
    if (arbitration.source !== "human") continue;
    rulings.set(contentionId, {
      ruling: arbitration.ruling,
      reasoning: arbitration.reasoning,
      targets: proj.contentions[contentionId]?.targets ?? [],
    });
  }
  return rulings;
}

export type SessionState = "running" | "approved" | "not_approved" | "awaiting_human" | "cancelled" | "errored";

/**
 * One label for where a session stands, for listings. "running" only means no terminal event has
 * been recorded; whether a process is actually still working it is a separate, live question
 * (see isSessionActive) that callers combine with this to detect orphaned sessions.
 */
export function sessionState(proj: SessionProjection): SessionState {
  if (proj.cancelled) return "cancelled";
  if (proj.errored) return "errored";
  if (proj.outcome === "APPROVED") return "approved";
  if (proj.outcome === "NOT_APPROVED") return "not_approved";
  if (proj.outcome === "AWAITING_HUMAN") return "awaiting_human";
  return "running";
}
