#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CLI_SEATS } from "@conclave/core";
import { checkAllSeatHealth, probeSeatModel, suggestXeniaModels } from "../auth/authStatus.js";
import { applyModelOverrides, modelCatalog, parseModelOverrides } from "../seats/modelCatalog.js";
import { SeatConfigInvalidError, SeatConfigStore } from "../http/seatConfigStore.js";
import {
  ApplyConflictError,
  applySessionChanges,
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

const HELP = `Usage: conclave run "<question or task>" [--cwd <path>] [--db <path>] [--budget <usd>] [--model <seat>=<model>]... [--allow-dirty-source]
       conclave list [--db <path>] [--limit <n>]
       conclave status <session-id> [--db <path>]
       conclave resume <session-id> [--db <path>]
       conclave cancel <session-id> [--db <path>]
       conclave arbitrate <session-id> [<contention-id> uphold|dismiss --reason "<why>"] [--db <path>]
       conclave prune --older-than <days> [--dry-run] [--db <path>]
       conclave apply <session-id> [--check] [--db <path>]
       conclave seats [models <seat> | set <seat> <model> [--force] | reset <seat> | test <seat> [<model>] | enable <seat> | disable <seat> | add <seat>] [--replace-invalid]
       conclave doctor

Commands:
  run <task>      Start a new council session against a task or question.
  list            List sessions in a repository's event store, most recent first.
  status <id>     Print the durable status of a session as JSON.
  resume <id>     Resume a session that crashed, was cancelled, or awaited a human ruling.
  cancel <id>     Cancel a session running in another process (terminal or web server).
  arbitrate <id>  Show contentions awaiting a human ruling, or settle one.
  prune           Remove worktrees preserved by old, unratified sessions (the event log is kept).
  apply <id>      Write a ratified session's changes into the plain (non-git) folder it ran on.
                  --check (or --dry-run) lists what would change without writing anything.
  seats           Show each seat and the model it uses; list, switch, test, or reset a seat's model,
                  enable/disable a seat, or add a built-in seat (e.g. grok) missing from a saved
                  config. Changes apply to new councils.
  doctor          Check that every configured seat's provider is installed and reachable.

Options:
  --cwd <path>    Working directory / repo to review (default: current directory).
  --db <path>     The SQLite event store. Default: the store the session was registered in, else
                  <cwd>/.conclave/events.db.
  --budget <usd>  Spend ceiling for this session (default: 20).
  --model <seat>=<model>  Use a different model for one seat, for this council only (repeatable).
                  Recorded with the session, so a resume keeps it.
  --allow-dirty-source  Permit running against a working tree with uncommitted changes.
  --replace-invalid  Let a seats change overwrite an invalid seat-config.json (it is backed up first).
  -h, --help      Show this help and exit.

Options take a separate value (--db x) or an inline one (--db=x). A task that itself starts with "-"
goes after --, e.g. conclave run -- "-v flag is ignored".
`;

/**
 * The seat configuration every command works from. `doctor` and `run` must resolve seats
 * identically — otherwise doctor reports on one council while run silently uses another.
 */
function loadSeatConfig(): SeatConfigStore {
  return new SeatConfigStore(process.env.CONCLAVE_SEAT_CONFIG_PATH ?? join(homedir(), ".conclave", "seat-config.json"));
}

/** The model a seat is set to; undefined means its CLI's own default. */
const modelOf = (seat: { adapter: string; cliModel?: string; xeniaModel?: string }) =>
  seat.adapter === "xenia" ? seat.xeniaModel : seat.adapter === "cli" ? seat.cliModel : undefined;

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

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** The options each command accepts: flags that take a value, and flags that don't. */
const OPTIONS: Record<string, { values: string[]; booleans: string[] }> = {
  doctor: { values: [], booleans: [] },
  resume: { values: ["--db"], booleans: [] },
  status: { values: ["--db"], booleans: [] },
  cancel: { values: ["--db"], booleans: [] },
  apply: { values: ["--db"], booleans: ["--check", "--dry-run"] },
  seats: { values: [], booleans: ["--force", "--replace-invalid"] },
  list: { values: ["--db", "--limit"], booleans: [] },
  arbitrate: { values: ["--db", "--reason", "--arbiter"], booleans: [] },
  prune: { values: ["--older-than", "--db"], booleans: ["--dry-run"] },
  run: { values: ["--cwd", "--db", "--budget", "--model"], booleans: ["--allow-dirty-source"] },
  council: { values: ["--cwd", "--db", "--budget", "--model"], booleans: ["--allow-dirty-source"] },
};

interface ParsedArgs {
  positionals: string[];
  /** Every value given for each value flag, in order (--model repeats). */
  values: Map<string, string[]>;
  flags: Set<string>;
}

/**
 * Strict argument parsing: `--flag value` and `--flag=value`, `--` ends the options, a value flag
 * without a value is an error, and so is any option the command doesn't know — a typo such as
 * `--dryrun` must never be ignored and leave the command to do the real thing. `-h`/`--help`
 * anywhere prints help instead of running anything.
 */
function parseArgs(args: string[], spec: { values: string[]; booleans: string[] }): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    }
    if (!arg.startsWith("-") || arg === "-" || /^-\d/.test(arg)) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (spec.values.includes(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++index];
      if (value === undefined || (eq < 0 && value.startsWith("--"))) fail(`${name} needs a value.`);
      parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
    } else if (spec.booleans.includes(name)) {
      if (eq > 0) fail(`${name} takes no value.`);
      parsed.flags.add(name);
    } else {
      const known = [...spec.values, ...spec.booleans];
      fail(`Unknown option ${name} for "conclave ${command}".${known.length ? ` Options: ${known.join(", ")}.` : ""} A task that starts with "-" goes after --.`);
    }
  }
  return parsed;
}

const args = parseArgs(rest, OPTIONS[command ?? ""] ?? { values: [], booleans: [] });
/** The last value given for a flag. */
const option = (flag: string): string | undefined => args.values.get(flag)?.at(-1);

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
function dbPathForSession(sessionId: string): string {
  const dbPath = option("--db") ?? withRegistry((registry) => registry.get(sessionId)?.dbPath) ?? defaultDbPath(process.cwd());
  if (!existsSync(dbPath)) fail(`no session found with id ${sessionId} (there is no event store at ${dbPath}; pass --db if it lives elsewhere)`);
  return dbPath;
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
  // SIGHUP too: closing the terminal must stop the council, not orphan its seat processes (each
  // runs in its own process group, out of reach of the terminal's hangup).
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  return run(controller.signal).finally(() => {
    for (const signal of signals) process.off(signal, onSignal);
  });
}

// Every expected failure (an unknown session id, a dirty tree, a missing store) is reported as one
// line and exit code 2 — distinct from 1, which means "the council did not approve".
try {
  if (command === "doctor") {
    const cwd = resolve(process.cwd());
    const config = loadSeatConfig();
    const seats = config.get().seats;
    // An invalid config silently falls back to the default seats, so the council that would run is
    // not the one the operator configured: that is a failure, not a footnote.
    const problem = config.problem();
    for (const warning of config.warnings()) console.log(`WARN             seat-config — ${warning}`);
    if (problem) {
      // Probing the fallback defaults would make billed calls to seats the operator never configured.
      console.log(`FAIL             seat-config — ${problem}`);
      console.log("        fix: correct the file, then run conclave doctor again. No seat was probed.");
      process.exit(1);
    }
    const results = await checkAllSeatHealth(seats, cwd);
    let anyRequiredUnhealthy = false;
    for (const result of results) {
      const seatConfig = seats.find((seat) => seat.id === result.seat);
      const required = seatConfig?.enabled !== false;
      const status = result.healthy ? "OK" : result.binaryFound ? "FAIL" : "MISSING";
      const label = required ? status : `${status} (disabled)`;
      if (!result.healthy && required) anyRequiredUnhealthy = true;
      const model = seatConfig?.adapter === "cli" ? ` · ${seatConfig.cliModel ?? "default model"}` : "";
      console.log(`${label.padEnd(16)} ${result.seat.padEnd(12)} (${result.cliCommand}${model}) — ${result.detail}`);
      if (!result.healthy) {
        console.log(`        ${required ? "fix" : "note"}: ${result.loginHint}`);
      }
    }
    process.exitCode = anyRequiredUnhealthy ? 1 : 0;
  } else if (command === "resume") {
    const [sessionId, extra] = args.positionals;
    if (!sessionId || extra) fail("Usage: conclave resume <session-id> [--db <path>]");
    const dbPath = dbPathForSession(sessionId);
    const result = await withAbortHandling((signal) => resumeCouncil({ sessionId, dbPath, signal }));
    console.log(`Session: ${result.sessionId}`);
    console.log(result.report);
    process.exitCode = result.approved ? 0 : 1;
  } else if (command === "status") {
    const [sessionId, extra] = args.positionals;
    if (!sessionId || extra) fail("Usage: conclave status <session-id> [--db <path>]");
    const dbPath = dbPathForSession(sessionId);
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
  } else if (command === "apply") {
    const [sessionId, extra] = args.positionals;
    if (!sessionId || extra) fail("Usage: conclave apply <session-id> [--check] [--db <path>]");
    const check = args.flags.has("--check") || args.flags.has("--dry-run");
    try {
      const { target, files } = await applySessionChanges({ dbPath: dbPathForSession(sessionId), sessionId, check });
      const mark = { added: "+", modified: "~", deleted: "-" } as const;
      for (const file of files) console.log(`  ${mark[file.change]} ${file.path}`);
      console.log(files.length === 0 ? "No changes to apply." : check ? `${files.length} change(s) would be applied to ${target}. Run without --check to apply them.` : `Applied ${files.length} change(s) to ${target}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = error instanceof ApplyConflictError ? 1 : 2;
    }
  } else if (command === "seats") {
    const config = loadSeatConfig();
    const { version, seats } = config.get();
    const [sub, seatId, candidate] = args.positionals;
    const find = (id: string | undefined) => {
      const seat = seats.find((s) => s.id === id);
      if (!seat) fail(`${id ? `No seat named "${id}". ` : ""}Seats: ${seats.map((s) => s.id).join(", ")}`);
      return seat;
    };
    const replace = (id: string, update: (seat: (typeof seats)[number]) => (typeof seats)[number]) => {
      try {
        config.save(
          seats.map((seat) => (seat.id === id ? update(seat) : seat)),
          { expectedVersion: version, replaceInvalid: args.flags.has("--replace-invalid") },
        );
      } catch (error) {
        if (error instanceof SeatConfigInvalidError) fail(`${error.message}\nNothing was changed. To overwrite it with the default seats plus this change, add --replace-invalid.`);
        fail(error instanceof Error ? error.message : String(error));
      }
    };

    if (!sub) {
      if (config.problem()) console.log(`warning: ${config.problem()}\n`);
      for (const warning of config.warnings()) console.log(`warning: ${warning}`);
      for (const seat of seats) {
        const model = seat.adapter === "fake" ? "(fake: no model)" : modelOf(seat) ?? "default model";
        console.log(`${seat.enabled ? "on " : "off"}  ${seat.id.padEnd(12)} ${seat.adapter.padEnd(6)} ${model}`);
      }
      console.log("\nSwitch a model: conclave seats models <seat>, then conclave seats set <seat> <model>");
    } else if (sub === "models") {
      const seat = find(seatId);
      const catalog = await modelCatalog(seat);
      const current = modelOf(seat);
      console.log(`Models for ${seat.id} (${catalog.source}${catalog.authoritative ? "" : "; any id the CLI accepts also works"}):`);
      if (catalog.error) console.log(`  could not list models: ${catalog.error}`);
      for (const model of catalog.models) {
        console.log(`  ${model.id === current ? "●" : " "} ${model.id}${model.label ? `  ${model.label}` : ""}`);
      }
      if (!current && seat.adapter === "cli") console.log(`  ● default model${catalog.defaultModel ? ` (${catalog.defaultModel}, from ${catalog.defaultSource})` : " (whatever the CLI is configured to use)"}`);
      if (catalog.note) console.log(`\n${catalog.note}`);
    } else if (sub === "set") {
      const seat = find(seatId);
      if (!candidate) fail("Usage: conclave seats set <seat> <model>");
      if (seat.adapter === "fake") fail(`${seat.id} is a fake seat; it has no model to switch.`);
      const catalog = await modelCatalog(seat);
      if (seat.cliArgsTemplate?.length) fail(`${seat.id} runs from an argument template, which names its own model; edit cliArgsTemplate in the seat config instead.`);
      if (catalog.authoritative && !catalog.models.some((model) => model.id === candidate) && !args.flags.has("--force")) {
        const close = suggestXeniaModels(candidate, catalog.models.map((model) => model.id));
        fail(`"${candidate}" is not in ${catalog.source}.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""} Use --force to set it anyway.`);
      }
      replace(seat.id, (s) => applyModelOverrides([s], { [s.id]: candidate })[0]!);
      console.log(`${seat.id} now uses ${candidate} for new councils.`);
      console.log(`Try it before relying on it (one small billed call): conclave seats test ${seat.id}`);
    } else if (sub === "reset") {
      const seat = find(seatId);
      if (seat.adapter === "xenia") fail(`${seat.id} is a xenia seat and always needs a model; switch it with conclave seats set.`);
      replace(seat.id, (s) => ({ ...s, cliModel: undefined }));
      console.log(`${seat.id} now uses its CLI's default model for new councils.`);
    } else if (sub === "test") {
      const seat = find(seatId);
      const model = candidate ?? modelOf(seat);
      console.error(`Testing ${seat.id} with ${model ?? "its default model"} (one small billed call)…`);
      const result = await probeSeatModel(seat, model, resolve(process.cwd()));
      console.log(`${result.healthy ? "OK  " : "FAIL"} ${seat.id} · ${result.model ?? "default model"}${result.answeredBy && result.answeredBy !== result.model ? ` (answered by ${result.answeredBy})` : ""} — ${result.detail}`);
      if (!result.healthy && result.loginHint) console.log(`     fix: ${result.loginHint}`);
      process.exitCode = result.healthy ? 0 : 1;
    } else if (sub === "add") {
      const available = DEFAULT_CLI_SEATS.filter((seat) => !seats.some((s) => s.id === seat.id));
      const builtIn = DEFAULT_CLI_SEATS.find((seat) => seat.id === seatId);
      if (!builtIn) fail(`${seatId ? `No built-in seat named "${seatId}". ` : ""}Built-in seats: ${DEFAULT_CLI_SEATS.map((seat) => seat.id).join(", ")}`);
      if (seats.some((seat) => seat.id === builtIn.id)) fail(`${builtIn.id} is already in your seats${available.length ? `; seats you can add: ${available.map((seat) => seat.id).join(", ")}` : ""}.`);
      try {
        config.save([...seats, { ...builtIn }], { expectedVersion: version, replaceInvalid: args.flags.has("--replace-invalid") });
      } catch (error) {
        if (error instanceof SeatConfigInvalidError) fail(`${error.message}\nNothing was changed. To overwrite it with the default seats plus this change, add --replace-invalid.`);
        fail(error instanceof Error ? error.message : String(error));
      }
      console.log(`${builtIn.id} (${builtIn.label}, ${builtIn.role}) added for new councils.`);
      console.log(`Check it can answer (one small billed call): conclave seats test ${builtIn.id}`);
    } else if (sub === "enable" || sub === "disable") {
      const seat = find(seatId);
      if (sub === "disable" && seat.id === "claude") fail("Claude must remain enabled: it is the only seat that plans, executes and remediates.");
      replace(seat.id, (s) => ({ ...s, enabled: sub === "enable" }));
      console.log(`${seat.id} ${sub === "enable" ? "enabled" : "disabled"} for new councils.`);
    } else {
      fail("Usage: conclave seats [models <seat> | set <seat> <model> | reset <seat> | test <seat> [<model>] | enable <seat> | disable <seat> | add <seat>]");
    }
  } else if (command === "list") {
    const dbPath = option("--db") ?? defaultDbPath(process.cwd());
    const limitFlag = option("--limit");
    const limit = limitFlag === undefined ? 20 : Number(limitFlag);
    if (!Number.isInteger(limit) || limit <= 0) fail("--limit must be a positive whole number");
    // No store yet means no sessions yet — not an error, and nothing to create.
    const sessions = existsSync(dbPath) ? listSessionHistory(dbPath, limit) : [];
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
    const [sessionId, extra] = args.positionals;
    if (!sessionId || extra) fail("Usage: conclave cancel <session-id> [--db <path>]");
    const dbPath = dbPathForSession(sessionId);
    try {
      requestCancel(dbPath, sessionId);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    console.log(`Cancellation requested for ${sessionId}. The running process stops at its next check (within a second) and preserves the worktree.`);
  } else if (command === "arbitrate") {
    const [sessionId, contentionId, verb, extra] = args.positionals;
    if (!sessionId || extra) fail('Usage: conclave arbitrate <session-id> [<contention-id> uphold|dismiss --reason "<why>"] [--db <path>]');
    const dbPath = dbPathForSession(sessionId);
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
      const reason = option("--reason");
      if (!ruling || !reason) fail('Usage: conclave arbitrate <session-id> <contention-id> uphold|dismiss --reason "<why>"');
      try {
        recordHumanRuling({ dbPath, sessionId, contentionId, ruling, reasoning: reason, arbiter: option("--arbiter") });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      const remaining = pendingHumanRulings(getSessionStatus(dbPath, sessionId)).length;
      console.log(`Recorded: ${contentionId} ${ruling.toLowerCase()}.`);
      console.log(remaining > 0 ? `${remaining} contention(s) still await a ruling.` : `Nothing else awaits a ruling. Continue with: conclave resume ${sessionId}`);
    }
  } else if (command === "prune") {
    const olderThan = option("--older-than");
    const days = olderThan === undefined ? Number.NaN : Number(olderThan);
    if (!Number.isFinite(days) || days < 0 || args.positionals.length > 0) fail("Usage: conclave prune --older-than <days> [--dry-run] [--db <path>]");
    const dryRun = args.flags.has("--dry-run");
    const dbPath = option("--db") ?? defaultDbPath(process.cwd());
    const result = await pruneSessions({ dbPath, olderThanMs: days * 86_400_000, dryRun });
    for (const item of result.pruned) {
      console.log(`${dryRun ? "would prune" : "pruned"}  ${item.sessionId}  ${item.state.padEnd(14)} last active ${item.lastActivity}  ${item.worktreePath}${item.branchDeleted ? " (empty branch deleted)" : ""}`);
    }
    for (const item of result.skipped) console.log(`skipped  ${item.sessionId}  ${item.reason}`);
    if (result.pruned.length === 0 && result.skipped.length === 0) console.log(`Nothing older than ${days} day(s) to prune in ${dbPath}.`);
  } else if (["council", "run"].includes(command ?? "") && rest.length > 0) {
    const task = args.positionals.join(" ").trim();
    if (!task) fail('Usage: conclave run "<question or task>" [--cwd <path>] [--db <path>] [--budget <usd>] [--allow-dirty-source]');
    const cwd = canonical(option("--cwd") ?? process.cwd());
    const dbPath = option("--db") ?? defaultDbPath(cwd);
    const budgetFlag = option("--budget");
    const budgetCeilingUsd = budgetFlag === undefined ? undefined : Number(budgetFlag);
    if (budgetCeilingUsd !== undefined && !(Number.isFinite(budgetCeilingUsd) && budgetCeilingUsd > 0)) fail("--budget must be a positive number of US dollars");
    const config = loadSeatConfig();
    // An invalid config falls back to the default seats: running would convene (and bill) a council
    // the operator never configured.
    const problem = config.problem();
    if (problem) fail(`${problem}\nNo council was started. Fix the file (conclave doctor explains it), then run again.`);
    let councilSeats = config.get().seats;
    try {
      councilSeats = applyModelOverrides(councilSeats, parseModelOverrides(args.values.get("--model") ?? []));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const sessionId = newSessionId();
    // Registered up front so `conclave status|cancel <id>` from any directory, and the web UI, can
    // find a CLI-started session while it is still running.
    withRegistry((registry) => registry.register(sessionId, dbPath, cwd));
    console.error(`Session: ${sessionId} (cancel from another terminal with: conclave cancel ${sessionId})`);
    const result = await withAbortHandling((signal) =>
      runCouncil({ task, cwd, dbPath, sessionId, allowDirtySource: args.flags.has("--allow-dirty-source"), budgetCeilingUsd, seats: councilSeats, signal }),
    );
    withRegistry((registry) => registry.touch(sessionId));
    console.log(`Session: ${result.sessionId}`);
    console.log(result.report);
    process.exitCode = result.approved ? 0 : 1;
  } else {
    console.error(HELP);
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
