import type { SessionProjection } from "../store/projections.js";
import { pendingHumanRulings, sessionState, summarizeDeliberation } from "../store/projections.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Browser-facing view of one session's full deliberative state. The raw projection carries
 * absolute paths (repo checkout, worktree, artifact files) and unbounded model text; this is the
 * only shape of it that leaves the server. Paths are replaced by what a client can act on (the
 * branch name, the artifact kind), and every free-text field goes through the same redaction and
 * length cap as chat messages.
 */
export function toClientSession(proj: SessionProjection, absolutePaths: string[], live: { running: boolean }) {
  const text = (value: string | undefined) => (value === undefined ? undefined : sanitizeText(value, absolutePaths));
  const state = sessionState(proj);
  return {
    sessionId: proj.sessionId,
    task: text(proj.task),
    state: live.running ? "running" : state === "running" ? "orphaned" : state,
    running: live.running,
    orphaned: !live.running && state === "running" && proj.phaseOpen,
    outcome: proj.outcome,
    outcomeReason: text(proj.outcomeReason),
    currentPhase: proj.currentPhase,
    currentRound: proj.currentRound,
    phaseOpen: proj.phaseOpen,
    spentUsd: proj.spentUsd,
    budgetCeilingUsd: proj.budgetCeilingUsd,
    branch: proj.worktree?.branch,
    worktreeState: proj.worktreeRemoved ? "removed" : proj.worktreeKept ? "kept" : proj.worktree ? "active" : "none",
    cancelReason: text(proj.cancelReason),
    fatalError: text(proj.fatalError),
    seats: (proj.seats ?? []).map((seat) => ({ id: seat.id, label: seat.label, role: seat.role, adapter: seat.adapter })),
    findings: Object.values(proj.findings).map((finding) => ({
      id: finding.id,
      seat: finding.seat,
      target: text(finding.target),
      severity: finding.severity,
      category: finding.category,
      description: text(finding.description),
      confidence: finding.confidence,
      falsifiableTest: text(finding.falsifiable_test ?? undefined),
      addressed: !!finding.addressed,
    })),
    contentions: Object.entries(proj.contentions).map(([contentionId, contention]) => ({
      contentionId,
      status: contention.status,
      targets: contention.targets.map((target) => text(target)!),
      category: contention.category,
      severity: contention.severity,
      thread: contention.thread.map((message) => ({ author: message.author, stance: message.stance, reasoning: text(message.reasoning) })),
      ruling: proj.arbitrations[contentionId]
        ? {
            ruling: proj.arbitrations[contentionId].ruling,
            source: proj.arbitrations[contentionId].source,
            arbiters: proj.arbitrations[contentionId].arbiters,
            reasoning: text(proj.arbitrations[contentionId].reasoning),
          }
        : undefined,
    })),
    verifications: proj.verifications.map((run) => ({ findingId: run.findingId, contentionId: run.contentionId, result: run.result, command: text(run.command), output: text(run.output) })),
    awaitingHumanRuling: pendingHumanRulings(proj).map((item) => item.contentionId),
    artifacts: proj.artifacts.map((artifact) => ({ kind: artifact.kind, version: artifact.version, hash: artifact.hash })),
    resumes: proj.resumes.map((resume) => ({ fromPhase: resume.fromPhase, fromRound: resume.fromRound, reason: text(resume.reason), ts: resume.ts })),
    deliberation: summarizeDeliberation(proj),
  };
}
export type ClientSession = ReturnType<typeof toClientSession>;
