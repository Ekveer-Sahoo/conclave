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
