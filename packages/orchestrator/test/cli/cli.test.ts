import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = resolve(fileURLToPath(import.meta.url), "../../../dist/cli/index.js");

/**
 * The CLI end to end against an in-process fake council (no provider CLIs, no network): the seat
 * config file points every seat at the `fake` adapter, which approves by default.
 */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "conclave-cli-home-"));
  const repo = await realpath(await mkdtemp(join(tmpdir(), "conclave-cli-repo-")));
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: repo });
  const seat = (id: string) => ({ id, label: id, adapter: "fake", role: "CORRECTNESS" });
  const seatConfig = join(home, "seat-config.json");
  await writeFile(seatConfig, JSON.stringify({ version: 1, seats: [seat("claude"), seat("codex")] }));
  const env = { ...process.env, CONCLAVE_SEAT_CONFIG_PATH: seatConfig, CONCLAVE_SESSION_REGISTRY_PATH: join(home, "registry.db") };
  const run = (args: string[], cwd = repo) =>
    execFileAsync(process.execPath, [cli, ...args], { cwd, env, timeout: 60_000 }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  return { home, repo, run };
}

test("run → list → status → arbitrate → cancel → prune, with sessions found through the registry from any directory", async () => {
  const { home, repo, run } = await sandbox();

  const first = await run(["run", "add", "a", "readme", "--budget", "2"]);
  assert.equal(first.code, 0, first.stderr);
  const sessionId = /Session: (\S+)/.exec(first.stdout)?.[1];
  assert.ok(sessionId);
  assert.match(first.stdout, /Outcome: RATIFIED/);

  // Conclave's own .conclave/ state directory must not make the next run look like a dirty checkout.
  const second = await run(["run", "second", "task"]);
  assert.equal(second.code, 0, second.stderr);

  const listed = await run(["list"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.stdout.includes(sessionId));
  assert.match(listed.stdout, /approved/);

  // From an unrelated directory, with no --db: the registry knows where the session lives.
  const status = await run(["status", sessionId], home);
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout) as { state: string; outcome: string; budgetCeilingUsd: number; running: boolean };
  assert.equal(parsed.state, "approved");
  assert.equal(parsed.outcome, "APPROVED");
  assert.equal(parsed.budgetCeilingUsd, 2);
  assert.equal(parsed.running, false);

  const arbitrate = await run(["arbitrate", sessionId], home);
  assert.match(arbitrate.stdout, /Nothing in session .* is awaiting a human ruling/);
  const badRuling = await run(["arbitrate", sessionId, "c-x", "maybe"], home);
  assert.equal(badRuling.code, 2);

  const cancel = await run(["cancel", sessionId], home);
  assert.equal(cancel.code, 2);
  assert.match(cancel.stderr, /not running/);

  const prune = await run(["prune", "--older-than", "0", "--dry-run"]);
  assert.equal(prune.code, 0);
  assert.match(prune.stdout, /Nothing older than 0 day/, "ratified sessions have no worktree left to prune");

  assert.equal((await run(["run"])).code, 2);
  assert.equal((await run(["run", "x", "--budget", "-3"])).code, 2);
  assert.equal((await run(["bogus"])).code, 2);
});

test("conclave seats lists, switches, resets, and guards seats; run --model rejects unknown seats", async () => {
  const { home, repo, run } = await sandbox();
  const configPath = join(home, "seat-config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, seats: [
    { id: "claude", label: "Claude", adapter: "fake", role: "ARCHITECTURE" },
    { id: "helper", label: "Helper", adapter: "cli", cliCommand: "definitely-not-installed", role: "CORRECTNESS", enabled: false },
  ] }));
  const listed = await run(["seats"]);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /claude\s+fake/);
  assert.match(listed.stdout, /off\s+helper\s+cli\s+default model/);

  const set = await run(["seats", "set", "helper", "some-model-2"]);
  assert.equal(set.code, 0, set.stderr);
  const saved = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8")) as { seats: Array<{ id: string; cliModel?: string }> };
  assert.equal(saved.seats.find((s) => s.id === "helper")?.cliModel, "some-model-2");
  assert.match((await run(["seats"])).stdout, /helper\s+cli\s+some-model-2/);

  assert.equal((await run(["seats", "reset", "helper"])).code, 0);
  assert.match((await run(["seats"])).stdout, /helper\s+cli\s+default model/);

  assert.equal((await run(["seats", "set", "claude", "x"])).code, 2, "a fake seat has no model to switch");
  assert.equal((await run(["seats", "disable", "claude"])).code, 2, "claude cannot be disabled");
  assert.equal((await run(["seats", "set", "nosuch", "x"])).code, 2);
  assert.match((await run(["seats", "models", "claude"])).stdout, /ignore the model/);

  const badRun = await run(["run", "task", "--model", "nosuch=x"]);
  assert.equal(badRun.code, 2);
  assert.match(badRun.stderr, /no seat named nosuch/);
  assert.equal((await run(["run", "task", "--model", "claude"])).code, 2);
  void repo;
});

test("options are parsed strictly: --help anywhere, --flag=value, unknown options refused, bad values refused", async () => {
  const { home, repo, run } = await sandbox();
  const help = await run(["run", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: conclave run/);
  assert.match((await run(["list"])).stdout, /No sessions/, "--help after a command runs nothing");

  const inline = await run(["run", "add", "a", "readme", `--db=${join(home, "inline.db")}`, "--budget=3"]);
  assert.equal(inline.code, 0, inline.stderr);
  assert.match(inline.stdout, /Task: add a readme\n/, "inline values are options, not task text");
  assert.match(inline.stdout, /of a \$3\.00 ceiling/);

  const unknown = await run(["prune", "--older-than", "0", "--dryrun"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option --dryrun/);

  const missing = await run(["run", "task", "--budget"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--budget needs a value/);

  const limit = await run(["list", "--limit", "2.5"]);
  assert.equal(limit.code, 2);
  assert.match(limit.stderr, /--limit must be a positive whole number/);

  const unknownSession = await run(["status", "no-such-session"]);
  assert.equal(unknownSession.code, 2);
  assert.match(unknownSession.stderr, /no session found/);
  assert.doesNotMatch(unknownSession.stderr, /\n\s+at /, "a plain message, not a stack trace");
  void repo;
});

test("run refuses to start when the seat config is invalid, rather than convening the default (billed) seats", async () => {
  const { home, run } = await sandbox();
  await writeFile(join(home, "seat-config.json"), JSON.stringify({ version: 3, seats: [{ id: "claude", label: "c", adapter: "fake", role: "REVIEWER" }] }));
  const result = await run(["run", "a", "task"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is invalid/);
  assert.match(result.stderr, /No council was started/);
  const seats = await run(["seats", "disable", "codex"]);
  assert.equal(seats.code, 2, "a seats change does not silently replace the invalid file");
  assert.match(seats.stderr, /--replace-invalid/);
});
