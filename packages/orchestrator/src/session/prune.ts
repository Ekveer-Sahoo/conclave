import { existsSync } from "node:fs";
import { EventStore } from "../store/eventStore.js";
import { projectSession, sessionState, type SessionState } from "../store/projections.js";
import { pruneWorktree } from "../worktree/worktree.js";
import { isSessionActive } from "./autonomousCouncil.js";

export interface PruneCandidate {
  sessionId: string;
  task?: string;
  state: SessionState;
  lastActivity: string;
  worktreePath: string;
  branch: string;
}

export interface PruneResult {
  pruned: Array<PruneCandidate & { branchDeleted: boolean }>;
  /** Sessions old enough to prune that were left alone, and why. */
  skipped: Array<{ sessionId: string; reason: string }>;
}

/**
 * Retention for the one thing Conclave leaves behind that actually costs disk: worktrees preserved
 * for inspection after a session that was not ratified (or crashed, or was cancelled). A ratified
 * session's worktree is already gone and its branch holds the work, so it is never a candidate.
 *
 * The event log is deliberately not pruned. It is small, it is the audit trail, and every
 * projection — including "this worktree was pruned" — is derived from it. Pruning appends a
 * WorktreeRemoved event rather than deleting history.
 */
export async function pruneSessions(options: { dbPath: string; olderThanMs: number; dryRun?: boolean; now?: number }): Promise<PruneResult> {
  const cutoff = (options.now ?? Date.now()) - options.olderThanMs;
  const result: PruneResult = { pruned: [], skipped: [] };
  const store = new EventStore(options.dbPath);
  try {
    for (const sessionId of store.listSessions()) {
      const events = store.replay(sessionId);
      const last = events.at(-1);
      if (!last || Date.parse(last.ts) > cutoff) continue;
      const proj = projectSession(sessionId, events);
      if (!proj.worktree || proj.worktreeRemoved) continue;
      if (isSessionActive(options.dbPath, sessionId)) {
        result.skipped.push({ sessionId, reason: "a process is still running it" });
        continue;
      }
      if (!proj.repoPath) {
        result.skipped.push({ sessionId, reason: "no recorded source repository" });
        continue;
      }
      const candidate: PruneCandidate = {
        sessionId,
        task: proj.task,
        state: sessionState(proj),
        lastActivity: last.ts,
        worktreePath: proj.worktree.path,
        branch: proj.worktree.branch,
      };
      if (options.dryRun) {
        result.pruned.push({ ...candidate, branchDeleted: false });
        continue;
      }
      const { branchDeleted } = await pruneWorktree({
        path: proj.worktree.path,
        branch: proj.worktree.branch,
        baseCommit: proj.worktree.baseCommit,
        sourceCwd: proj.repoPath,
      });
      if (existsSync(proj.worktree.path)) {
        result.skipped.push({ sessionId, reason: `could not remove ${proj.worktree.path}` });
        continue;
      }
      const days = Math.round(options.olderThanMs / 86_400_000);
      store.append(sessionId, { type: "WorktreeRemoved", payload: { reason: `pruned: no activity for over ${days} day(s)${branchDeleted ? "; empty session branch deleted" : ""}` } });
      result.pruned.push({ ...candidate, branchDeleted });
    }
  } finally {
    store.close();
  }
  return result;
}
