import { resumePlan } from "../session/autonomousCouncil.js";
import type { SessionProjection } from "../store/projections.js";
import { pendingHumanRulings, sessionState, summarizeDeliberation } from "../store/projections.js";
import { sanitizeText, type RedactablePath } from "./sanitize.js";

/**
 * Browser-facing view of one session's full deliberative state. The raw projection carries
 * absolute paths (repo checkout, worktree, artifact files) and unbounded model text; this is the
 * only shape of it that leaves the server. Paths are replaced by what a client can act on (the
 * branch name, the artifact kind), and every free-text field goes through the same redaction and
 * length cap as chat messages.
 */
/**
 * Resumable exactly when `resumeCouncil` would accept it, so no view ever offers an action the
 * server is going to refuse: not while a process runs it, not once ratified or pruned, and not
 * while it waits on a human ruling.
 */
export function isResumable(proj: SessionProjection, running: boolean): boolean {
  const state = sessionState(proj);
  return (
    !running &&
    state !== "approved" &&
    !!proj.worktree &&
    !proj.worktreeRemoved &&
    proj.seats !== undefined &&
    // A session that spent its budget is refused on resume; offering the button would only fail.
    !(proj.budgetCeilingUsd !== undefined && proj.spentUsd >= proj.budgetCeilingUsd) &&
    !(state === "awaiting_human" && pendingHumanRulings(proj).length > 0)
  );
}

export function toClientSession(proj: SessionProjection, absolutePaths: RedactablePath[], live: { running: boolean; repo?: string }) {
  const text = (value: string | undefined) => (value === undefined ? undefined : sanitizeText(value, absolutePaths));
  const state = sessionState(proj);
  const pending = pendingHumanRulings(proj);
  const invocations = Object.values(proj.seatInvocations);
  const resumable = isResumable(proj, live.running);
  return {
    sessionId: proj.sessionId,
    repo: live.repo,
    startedAt: proj.startedAt,
    updatedAt: proj.updatedAt,
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
    budgetRemainingUsd: proj.budgetCeilingUsd === undefined ? undefined : Math.max(0, proj.budgetCeilingUsd - proj.spentUsd),
    planRevisions: Math.max(0, proj.planVersion - 1),
    resumable,
    resumeFrom: resumable
      ? resumePlan(proj).entry
      : undefined,
    worktreeRemovedReason: text(proj.worktreeRemoved?.reason),
    branch: proj.worktree?.snapshot ? undefined : proj.worktree?.branch,
    // "snapshot": run on a private snapshot of a plain folder; its ratified work is applied to the
    // folder on request instead of being a branch to merge.
    workspace: proj.worktree?.snapshot ? "snapshot" : proj.worktree ? "git" : undefined,
    applicable: !!proj.worktree?.snapshot && state === "approved" && !proj.applied && !live.running,
    applied: proj.applied ? { at: proj.applied.at, files: proj.applied.files } : undefined,
    worktreeState: proj.worktreeRemoved ? "removed" : proj.worktreeKept ? "kept" : proj.worktree ? "active" : "none",
    cancelReason: text(proj.cancelReason),
    fatalError: text(proj.fatalError),
    // Per seat, what it actually did in this session — so a view can say "ratified by 2 of 3; Claude
    // dropped out at the work vote" instead of a bare "approved".
    seats: (proj.seats ?? []).map((seat) => {
      const mine = invocations.filter((invocation) => invocation.seat === seat.id);
      // The model the seat was set to for this session, and the models its provider reported actually
      // answering — which differ when an alias or a gateway's auto-routing picks the model.
      const configuredModel = seat.adapter === "xenia" ? seat.xeniaModel : seat.adapter === "cli" ? seat.cliModel : undefined;
      const modelsUsed = [...new Set(mine.map((invocation) => invocation.model).filter((model): model is string => !!model))];
      return {
        id: seat.id,
        label: seat.label,
        role: seat.role,
        adapter: seat.adapter,
        configuredModel,
        modelsUsed,
        spentUsd: proj.spendBySeat[seat.id] ?? 0,
        calls: mine.length,
        failures: mine.filter((invocation) => invocation.status !== "OK").map(({ phase, round, status }) => ({ phase, round, status })),
        verdicts: mine
          .filter((invocation) => invocation.verdict)
          .map((invocation) => ({ phase: invocation.phase, round: invocation.round, verdict: invocation.verdict!.overall_verdict })),
      };
    }),
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
    verifications: proj.verifications.map((run) => ({ findingId: run.findingId, contentionId: run.contentionId, seat: run.seat, result: run.result, command: text(run.command), output: text(run.output) })),
    awaitingHumanRuling: pending.map((item) => item.contentionId),
    artifacts: proj.artifacts.map((artifact) => ({ kind: artifact.kind, version: artifact.version, hash: artifact.hash })),
    resumes: proj.resumes.map((resume) => ({ fromPhase: resume.fromPhase, fromRound: resume.fromRound, reason: text(resume.reason), ts: resume.ts })),
    deliberation: summarizeDeliberation(proj),
  };
}
export type ClientSession = ReturnType<typeof toClientSession>;
