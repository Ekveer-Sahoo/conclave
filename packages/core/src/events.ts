import { z } from "zod";
import { PhaseSchema } from "./roles.js";
import { FindingSchema, VerdictSchema } from "./finding.js";

const base = <T extends z.ZodRawShape>(type: string, shape: T) =>
  z.object({ type: z.literal(type), payload: z.object(shape) });

export const SessionCreatedEvent = base("SessionCreated", {
  sessionId: z.string(),
  task: z.string(),
  budgetCeilingUsd: z.number().positive(),
  minQuorum: z.number().int().min(1).default(3),
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

export const ArbitrationRuledEvent = base("ArbitrationRuled", {
  contentionId: z.string(),
  arbiters: z.array(z.string()),
  ruling: z.string(),
  reasoning: z.string(),
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
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  compressionBefore: z.number().int().nonnegative().optional(),
  compressionAfter: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  costSource: z.enum(["local_estimate", "xenia_authoritative"]),
  latencyMs: z.number().int().nonnegative(),
});

export const SessionErroredEvent = base("SessionErrored", {
  message: z.string(),
  fatal: z.boolean(),
});

export const EventEnvelopeSchema = z.discriminatedUnion("type", [
  SessionCreatedEvent,
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
  ArbitrationRuledEvent,
  RatificationCastEvent,
  RatificationVoteMissingEvent,
  ContentionResolvedEvent,
  ArtifactWrittenEvent,
  BudgetSpentEvent,
  SessionErroredEvent,
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
