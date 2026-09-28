import { z } from "zod";
import { PhaseSchema } from "./roles.js";
import { FindingSchema, VerdictSchema } from "./finding.js";
import { SeatConfigSchema } from "./seat.js";

const base = <T extends z.ZodRawShape>(type: string, shape: T) =>
  z.object({ type: z.literal(type), payload: z.object(shape) });

export const SessionCreatedEvent = base("SessionCreated", {
  sessionId: z.string(),
  task: z.string(),
  budgetCeilingUsd: z.number().positive(),
  minQuorum: z.number().int().min(1).default(3),
});

/**
 * Durable record of every parameter runCouncil actually used, so a resumed session can
 * reconstruct deterministic behavior instead of falling back to current code defaults.
 * Emitted once, immediately after SessionCreated, at the start of every run — never on resume.
 */
export const SessionConfiguredEvent = base("SessionConfigured", {
  configVersion: z.number().int().positive().default(1),
  repoPath: z.string(),
  seats: z.array(SeatConfigSchema),
  discussionRoundCap: z.number().int().positive(),
  remediationRoundCap: z.number().int().nonnegative(),
  budgetCeilingUsd: z.number().positive(),
  allowDirtySource: z.boolean(),
});

export const WorktreeCreatedEvent = base("WorktreeCreated", {
  baseCommit: z.string(),
  branch: z.string(),
  path: z.string(),
});

export const WorktreeTreeHashRecordedEvent = base("WorktreeTreeHashRecorded", {
  phase: PhaseSchema,
  stage: z.enum(["before", "after"]),
  hash: z.string(),
});

export const WorktreeRemovedEvent = base("WorktreeRemoved", { reason: z.string() });
export const WorktreeKeptEvent = base("WorktreeKept", { reason: z.string() });

export const PhaseEnteredEvent = base("PhaseEntered", {
  phase: PhaseSchema,
  round: z.number().int().nonnegative().default(0),
});

export const PhaseExitedEvent = base("PhaseExited", {
  phase: PhaseSchema,
  round: z.number().int().nonnegative().default(0),
  outcome: z.string(),
});

export const SeatInvokedEvent = base("SeatInvoked", {
  correlationId: z.string(),
  seat: z.string(),
  phase: PhaseSchema,
  round: z.number().int().nonnegative(),
  verdict: VerdictSchema.optional(),
  status: z.enum(["OK", "UNAVAILABLE", "MALFORMED"]),
});

export const FindingRecordedEvent = base("FindingRecorded", {
  finding: FindingSchema,
  phase: PhaseSchema,
  round: z.number().int().nonnegative(),
});

export const FindingAddressedEvent = base("FindingAddressed", {
  findingId: z.string(),
  artifactVersion: z.number().int().nonnegative(),
  resolution: z.string(),
});

export const ContentionOpenedEvent = base("ContentionOpened", {
  contentionId: z.string(),
  targets: z.array(z.string()),
  category: z.string(),
  severity: z.enum(["BLOCKER", "MAJOR", "MINOR", "NIT"]),
  findingIds: z.array(z.string()),
});

export const ThreadMessageAddedEvent = base("ThreadMessageAdded", {
  contentionId: z.string(),
  author: z.string(),
  stance: z.enum([
    "ACCEPT", "REJECT", "CLARIFY", "COUNTER",
    "WITHDRAW", "HOLD", "AMEND", "SPLIT",
    "CO_SIGN", "DISSENT", "SYNTHESIS",
  ]),
  reasoning: z.string(),
  evidence: z.array(z.string()).default([]),
});

export const VerificationRunEvent = base("VerificationRun", {
  contentionId: z.string().optional(),
  findingId: z.string(),
  command: z.string(),
  result: z.enum(["TRUE", "FALSE", "INCONCLUSIVE"]),
  output: z.string(),
});

/**
 * General-purpose capture of a single allowlisted verification command a seat actually ran,
 * independent of whether it is tied to a specific finding. VerificationRunEvent stays
 * finding-scoped (its findingId is required); this event covers plan/execution checks that
 * have no finding to attach to. When a command IS explicitly tied to a finding, both events
 * are emitted for it.
 */
export const CommandVerificationRunEvent = base("CommandVerificationRun", {
  correlationId: z.string(),
  seat: z.string(),
  phase: PhaseSchema,
  round: z.number().int().nonnegative(),
  command: z.string(),
  result: z.enum(["PASS", "FAIL", "DENIED", "INCONCLUSIVE"]),
  exitCode: z.number().int().optional(),
  output: z.string(),
  findingId: z.string().optional(),
});

/**
 * `source` separates the deterministic policy's rulings from a human arbiter's. A human ruling is
 * how a HUMAN_ARBITRATION escalation actually gets settled: it is appended out-of-band (CLI or
 * API) and later rounds honor it instead of re-arbitrating the same contention.
 */
export const ArbitrationRuledEvent = base("ArbitrationRuled", {
  contentionId: z.string(),
  arbiters: z.array(z.string()),
  ruling: z.string(),
  reasoning: z.string(),
  source: z.enum(["policy", "human"]).default("policy"),
});

export const RatificationCastEvent = base("RatificationCast", {
  phase: z.enum(["RATIFY_PLAN", "RATIFY_WORK"]),
  round: z.number().int().nonnegative(),
  seat: z.string(),
  vote: z.enum(["APPROVE", "APPROVE_WITH_CHANGES", "REJECT"]),
  citedContentionId: z.string().optional(),
});

export const RatificationVoteMissingEvent = base("RatificationVoteMissing", {
  phase: z.enum(["RATIFY_PLAN", "RATIFY_WORK"]),
  round: z.number().int().nonnegative(),
  seat: z.string(),
  reason: z.enum(["UNAVAILABLE", "MALFORMED"]),
});

export const ContentionResolvedEvent = base("ContentionResolved", {
  contentionId: z.string(),
  terminalState: z.enum([
    "ACCEPTED", "WITHDRAWN", "SUPERSEDED", "DEFERRED", "ARBITRATED", "HUMAN_ARBITRATION",
  ]),
});

export const ArtifactWrittenEvent = base("ArtifactWritten", {
  kind: z.enum(["plan", "diff", "report"]),
  version: z.number().int().nonnegative(),
  hash: z.string(),
  path: z.string(),
});

export const BudgetSpentEvent = base("BudgetSpent", {
  correlationId: z.string(),
  seat: z.string().optional(),
  phase: PhaseSchema,
  round: z.number().int().nonnegative(),
  /** False when the provider's envelope carried no parseable, authoritative usage — in that case
   * promptTokens/completionTokens/costUsd are omitted rather than reported as zero. */
  usageAvailable: z.boolean().default(true),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  /** Cached input tokens, reported separately. Whether these are already included in
   * promptTokens is provider-specific: see ProviderUsage docs in cliAdapter.ts. */
  cachedInputTokens: z.number().int().nonnegative().optional(),
  compressionBefore: z.number().int().nonnegative().optional(),
  compressionAfter: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costSource: z.enum(["local_estimate", "xenia_authoritative", "provider_reported", "unavailable"]),
  latencyMs: z.number().int().nonnegative(),
});

export const SessionErroredEvent = base("SessionErrored", {
  message: z.string(),
  fatal: z.boolean(),
});

export const SessionCancelledEvent = base("SessionCancelled", {
  reason: z.string(),
});

/**
 * The council reached a verdict. Distinct from SessionErrored/SessionCancelled on purpose: a plan
 * the council refused to ratify is a legitimate outcome, not a crash, and must not be reported as
 * one. AWAITING_HUMAN means the run stopped with contention(s) escalated to human arbitration that
 * no human has ruled on yet — it becomes resumable once they have.
 */
export const SessionConcludedEvent = base("SessionConcluded", {
  outcome: z.enum(["APPROVED", "NOT_APPROVED", "AWAITING_HUMAN"]),
  reason: z.string(),
});

/**
 * Append-only marker that a crashed/cancelled/inconclusive session is being resumed. Clears
 * terminal cancelled/errored projection state going forward without rewriting prior events.
 */
export const SessionResumedEvent = base("SessionResumed", {
  fromPhase: PhaseSchema.optional(),
  fromRound: z.number().int().nonnegative().optional(),
  reason: z.string(),
});

/**
 * A chat message the user typed into the web UI, persisted so the master chat can be rebuilt
 * after a browser/server restart instead of living only in in-memory SSE history.
 */
export const UserMessagePostedEvent = base("UserMessagePosted", {
  text: z.string(),
});

/**
 * Durable record of a CouncilActivity item (phase/seat/system/report) so the master chat and
 * seat panes can be reconstructed from the event log alone, not only from live SSE broadcast.
 */
export const ActivityLoggedEvent = base("ActivityLogged", {
  kind: z.enum(["phase", "seat", "system", "report"]),
  message: z.string(),
  seat: z.string().optional(),
  phase: PhaseSchema.optional(),
  round: z.number().int().nonnegative().optional(),
  verdict: VerdictSchema.optional(),
});

export const EventEnvelopeSchema = z.discriminatedUnion("type", [
  SessionCreatedEvent,
  UserMessagePostedEvent,
  ActivityLoggedEvent,
  WorktreeCreatedEvent,
  WorktreeTreeHashRecordedEvent,
  WorktreeRemovedEvent,
  WorktreeKeptEvent,
  PhaseEnteredEvent,
  PhaseExitedEvent,
  SeatInvokedEvent,
  FindingRecordedEvent,
  FindingAddressedEvent,
  ContentionOpenedEvent,
  ThreadMessageAddedEvent,
  VerificationRunEvent,
  CommandVerificationRunEvent,
  ArbitrationRuledEvent,
  RatificationCastEvent,
  RatificationVoteMissingEvent,
  ContentionResolvedEvent,
  ArtifactWrittenEvent,
  BudgetSpentEvent,
  SessionErroredEvent,
  SessionCancelledEvent,
  SessionConcludedEvent,
  SessionConfiguredEvent,
  SessionResumedEvent,
]);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type EventType = EventEnvelope["type"];

export interface StoredEvent {
  seq: number;
  sessionId: string;
  ts: string;
  type: EventType;
  payload: unknown;
}
