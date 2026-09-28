#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkAllSeatHealth } from "../auth/authStatus.js";
import { SeatConfigStore } from "../http/seatConfigStore.js";
import {
  getSessionStatus,
  isSessionActive,
  listSessionHistory,
  recordHumanRuling,
  requestCancel,
  resumeCouncil,
  runCouncil,
} from "../session/autonomousCouncil.js";
import { pruneSessions } from "../session/prune.js";
import { newSessionId } from "../store/eventStore.js";
import { pendingHumanRulings, sessionState, summarizeDeliberation } from "../store/projections.js";
import { SessionRegistry } from "../store/sessionRegistry.js";

const HELP = `Usage: conclave run "<question or task>" [--cwd <path>] [--db <path>] [--budget <usd>] [--allow-dirty-source]
       conclave list [--db <path>] [--limit <n>]
       conclave status <session-id> [--db <path>]
       conclave resume <session-id> [--db <path>]
       conclave cancel <session-id> [--db <path>]
       conclave arbitrate <session-id> [<contention-id> uphold|dismiss --reason "<why>"] [--db <path>]
       conclave prune --older-than <days> [--dry-run] [--db <path>]
       conclave doctor

Commands:
  run <task>      Start a new council session against a task or question.
  list            List sessions in a repository's event store, most recent first.
  status <id>     Print the durable status of a session as JSON.
  resume <id>     Resume a session that crashed, was cancelled, or awaited a human ruling.
  cancel <id>     Cancel a session running in another process (terminal or web server).
  arbitrate <id>  Show contentions awaiting a human ruling, or settle one.
  prune           Remove worktrees preserved by old, unratified sessions (the event log is kept).
  doctor          Check that every configured seat's provider is installed and reachable.

Options:
  --cwd <path>    Working directory / repo to review (default: current directory).
  --db <path>     The SQLite event store. Default: the store the session was registered in, else
                  <cwd>/.conclave/events.db.
  --budget <usd>  Spend ceiling for this session (default: 20).
  --allow-dirty-source  Permit running against a working tree with uncommitted changes.
  -h, --help      Show this help and exit.
`;

/**
 * The seat configuration every command works from. `doctor` and `run` must resolve seats
 * identically — otherwise doctor reports on one council while run silently uses another.
 */
function loadSeatConfig(): SeatConfigStore {
  return new SeatConfigStore(process.env.CONCLAVE_SEAT_CONFIG_PATH ?? join(homedir(), ".conclave", "seat-config.json"));
}
const loadSeats = () => loadSeatConfig().get().seats;

const REGISTRY_PATH = process.env.CONCLAVE_SESSION_REGISTRY_PATH ?? join(homedir(), ".conclave", "registry.db");

/** The registry is a convenience index; a missing or unusable one must never block a command. */
function withRegistry<T>(use: (registry: SessionRegistry) => T): T | undefined {
  let registry: SessionRegistry | undefined;
  try {
    registry = new SessionRegistry(REGISTRY_PATH);
    return use(registry);
  } catch {
    return undefined;
  } finally {
    registry?.close();
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === "-h" || command === "--help" || command === "help" || !command) {
  console.log(HELP);
  process.exit(command ? 0 : 2);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Positional arguments, with every `--flag value` pair (and bare boolean flags) removed. */
function positionals(args: string[], valueFlags: string[], booleanFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (valueFlags.includes(args[index]!)) {
      index += 1;
      continue;
    }
    if (booleanFlags.includes(args[index]!)) continue;
    out.push(args[index]!);
  }
  return out;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Canonical repository path, so the CLI and the web server register the same repo identically. */
function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

const defaultDbPath = (cwd: string) => join(canonical(cwd), ".conclave", "events.db");

/** Explicit --db wins; otherwise the registry knows which repository a session lives in. */
function dbPathForSession(args: string[], sessionId: string): string {
  return flagValue(args, "--db") ?? withRegistry((registry) => registry.get(sessionId)?.dbPath) ?? defaultDbPath(process.cwd());
}

function withAbortHandling<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signalCount += 1;
    if (signalCount === 1) {
      console.error(`\nReceived ${signal}; cancelling the running session and preserving its worktree for inspection...`);
      controller.abort(new Error(`cancelled by ${signal}`));
    } else {
      console.error(`\nReceived ${signal} again; still shutting down (a running seat process can take a few seconds to be killed).`);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return run(controller.signal).finally(() => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  });
}

if (command === "doctor") {
  const cwd = resolve(process.cwd());
  const config = loadSeatConfig();
  const seats = config.get().seats;
  // An invalid config silently falls back to the default seats, so the council that would run is
  // not the one the operator configured: that is a failure, not a footnote.
  const problem = config.problem();
  if (problem) console.log(`FAIL             seat-config — ${problem}`);
  const results = await checkAllSeatHealth(seats, cwd);
  let anyRequiredUnhealthy = !!problem;
  for (const result of results) {
    const seatConfig = seats.find((seat) => seat.id === result.seat);
    const required = seatConfig?.enabled !== false;
    const status = result.healthy ? "OK" : result.binaryFound ? "FAIL" : "MISSING";
    const label = required ? status : `${status} (disabled)`;
    if (!result.healthy && required) anyRequiredUnhealthy = true;
    console.log(`${label.padEnd(16)} ${result.seat.padEnd(12)} (${result.cliCommand}) — ${result.detail}`);
    if (!result.healthy) {
      console.log(`        ${required ? "fix" : "note"}: ${result.loginHint}`);
    }
  }
  process.exitCode = anyRequiredUnhealthy ? 1 : 0;
} else if (command === "resume") {
  const [sessionId] = positionals(rest, ["--db"]);
  if (!sessionId) fail("Usage: conclave resume <session-id> [--db <path>]");
  const dbPath = dbPathForSession(rest, sessionId);
  const result = await withAbortHandling((signal) => resumeCouncil({ sessionId, dbPath, signal }));
  console.log(`Session: ${result.sessionId}`);
  console.log(result.report);
  process.exitCode = result.approved ? 0 : 1;
} else if (command === "status") {
  const [sessionId] = positionals(rest, ["--db"]);
  if (!sessionId) fail("Usage: conclave status <session-id> [--db <path>]");
  const dbPath = dbPathForSession(rest, sessionId);
  const proj = getSessionStatus(dbPath, sessionId);
  console.log(
    JSON.stringify(
      {
        sessionId: proj.sessionId,
        task: proj.task,
        state: sessionState(proj),
        running: isSessionActive(dbPath, sessionId),
        outcome: proj.outcome,
        outcomeReason: proj.outcomeReason,
        currentPhase: proj.currentPhase,
        currentRound: proj.currentRound,
        phaseOpen: proj.phaseOpen,
        lastPhaseOutcome: proj.lastPhaseOutcome,
        spentUsd: proj.spentUsd,
        budgetCeilingUsd: proj.budgetCeilingUsd,
        worktree: proj.worktree,
        worktreeRemoved: !!proj.worktreeRemoved,
        worktreeKept: !!proj.worktreeKept,
        cancelled: proj.cancelled,
        cancelReason: proj.cancelReason,
        errored: proj.errored,
        fatalError: proj.fatalError,
        resumes: proj.resumes,
        artifacts: proj.artifacts,
        awaitingHumanRuling: pendingHumanRulings(proj).map(({ contentionId, targets, severity, reasoning }) => ({ contentionId, targets, severity, reasoning })),
        deliberation: summarizeDeliberation(proj),
      },
      null,
      2,
    ),
  );
} else if (command === "list") {
  const dbPath = flagValue(rest, "--db") ?? defaultDbPath(process.cwd());
  const limit = Number(flagValue(rest, "--limit") ?? 20);
  const sessions = listSessionHistory(dbPath, Number.isFinite(limit) && limit > 0 ? limit : 20);
  if (sessions.length === 0) {
    console.log(`No sessions in ${dbPath}.`);
  } else {
    for (const proj of sessions) {
      const live = isSessionActive(dbPath, proj.sessionId);
      const state = live ? "running" : sessionState(proj) === "running" ? "orphaned" : sessionState(proj);
      const task = (proj.task ?? "").replace(/\s+/g, " ");
      console.log(`${proj.sessionId}  ${state.padEnd(14)} ${(proj.currentPhase ?? "-").padEnd(12)} $${proj.spentUsd.toFixed(2).padStart(6)}  ${task.length > 60 ? `${task.slice(0, 59)}…` : task}`);
    }
  }
} else if (command === "cancel") {
  const [sessionId] = positionals(rest, ["--db"]);
  if (!sessionId) fail("Usage: conclave cancel <session-id> [--db <path>]");
  const dbPath = dbPathForSession(rest, sessionId);
  try {
    requestCancel(dbPath, sessionId);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`Cancellation requested for ${sessionId}. The running process stops at its next check (within a second) and preserves the worktree.`);
} else if (command === "arbitrate") {
  const args = positionals(rest, ["--db", "--reason", "--arbiter"]);
  const [sessionId, contentionId, verb] = args;
  if (!sessionId) fail('Usage: conclave arbitrate <session-id> [<contention-id> uphold|dismiss --reason "<why>"] [--db <path>]');
  const dbPath = dbPathForSession(rest, sessionId);
  if (!contentionId) {
    const pending = pendingHumanRulings(getSessionStatus(dbPath, sessionId));
    if (pending.length === 0) {
      console.log(`Nothing in session ${sessionId} is awaiting a human ruling.`);
    } else {
      for (const item of pending) {
        console.log(`${item.contentionId}  ${item.severity}  ${item.targets.join(", ")}`);
        if (item.reasoning) console.log(`    policy: ${item.reasoning}`);
        for (const message of item.thread.slice(-6)) console.log(`    ${message.author} (${message.stance}): ${message.reasoning}`);
      }
      console.log(`\nSettle one with: conclave arbitrate ${sessionId} <contention-id> uphold|dismiss --reason "<why>"`);
    }
  } else {
    const ruling = verb === "uphold" ? "UPHELD" : verb === "dismiss" ? "DISMISSED" : undefined;
    const reason = flagValue(rest, "--reason");
    if (!ruling || !reason) fail('Usage: conclave arbitrate <session-id> <contention-id> uphold|dismiss --reason "<why>"');
    try {
      recordHumanRuling({ dbPath, sessionId, contentionId, ruling, reasoning: reason, arbiter: flagValue(rest, "--arbiter") });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const remaining = pendingHumanRulings(getSessionStatus(dbPath, sessionId)).length;
    console.log(`Recorded: ${contentionId} ${ruling.toLowerCase()}.`);
    console.log(remaining > 0 ? `${remaining} contention(s) still await a ruling.` : `Nothing else awaits a ruling. Continue with: conclave resume ${sessionId}`);
  }
} else if (command === "prune") {
  const days = Number(flagValue(rest, "--older-than"));
  if (!Number.isFinite(days) || days < 0) fail("Usage: conclave prune --older-than <days> [--dry-run] [--db <path>]");
  const dryRun = rest.includes("--dry-run");
  const dbPath = flagValue(rest, "--db") ?? defaultDbPath(process.cwd());
  const result = await pruneSessions({ dbPath, olderThanMs: days * 86_400_000, dryRun });
  for (const item of result.pruned) {
    console.log(`${dryRun ? "would prune" : "pruned"}  ${item.sessionId}  ${item.state.padEnd(14)} last active ${item.lastActivity}  ${item.worktreePath}${item.branchDeleted ? " (empty branch deleted)" : ""}`);
  }
  for (const item of result.skipped) console.log(`skipped  ${item.sessionId}  ${item.reason}`);
  if (result.pruned.length === 0 && result.skipped.length === 0) console.log(`Nothing older than ${days} day(s) to prune in ${dbPath}.`);
} else if (["council", "run"].includes(command ?? "") && rest.length > 0) {
  const args = positionals(rest, ["--cwd", "--db", "--budget"], ["--allow-dirty-source"]);
  const task = args.join(" ").trim();
  if (!task) fail('Usage: conclave run "<question or task>" [--cwd <path>] [--db <path>] [--budget <usd>] [--allow-dirty-source]');
  const cwd = canonical(flagValue(rest, "--cwd") ?? process.cwd());
  const dbPath = flagValue(rest, "--db") ?? defaultDbPath(cwd);
  const budgetFlag = flagValue(rest, "--budget");
  const budgetCeilingUsd = budgetFlag === undefined ? undefined : Number(budgetFlag);
  if (budgetCeilingUsd !== undefined && !(Number.isFinite(budgetCeilingUsd) && budgetCeilingUsd > 0)) fail("--budget must be a positive number of US dollars");
  const sessionId = newSessionId();
  // Registered up front so `conclave status|cancel <id>` from any directory, and the web UI, can
  // find a CLI-started session while it is still running.
  withRegistry((registry) => registry.register(sessionId, dbPath, cwd));
  console.error(`Session: ${sessionId} (cancel from another terminal with: conclave cancel ${sessionId})`);
  const result = await withAbortHandling((signal) =>
    runCouncil({ task, cwd, dbPath, sessionId, allowDirtySource: rest.includes("--allow-dirty-source"), budgetCeilingUsd, seats: loadSeats(), signal }),
  );
  withRegistry((registry) => registry.touch(sessionId));
  console.log(`Session: ${result.sessionId}`);
  console.log(result.report);
  process.exitCode = result.approved ? 0 : 1;
} else {
  console.error(HELP);
  process.exit(2);
}
