import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SeatConfig } from "@conclave/core";
import { CliCancelledError, invokeCliSeat } from "../../src/seats/cliAdapter.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function seat(id: string, cliCommand: string, cliArgsTemplate: string[]): SeatConfig {
  return {
    id,
    label: id,
    adapter: "cli",
    cliCommand,
    cliArgsTemplate,
    role: "CORRECTNESS",
    temperature: 0.2,
    maxTokens: 100,
    timeoutMs: 30_000,
    enabled: true,
    tier: "standard",
  };
}

test("aborting a seat invocation rejects with CliCancelledError instead of hanging until the timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-cancel-"));
  const script = join(dir, "hang.mjs");
  await writeFile(script, `setInterval(() => {}, 1000);\n`);
  const controller = new AbortController();
  const invocation = invokeCliSeat({
    seat: seat("cancel-seat", process.execPath, [script]),
    prompt: "unused",
    cwd: dir,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("test cancellation")), 200);
  await assert.rejects(() => invocation, CliCancelledError);
});

test("aborting a seat invocation kills the whole child process tree, not just the direct child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-cancel-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  const script = join(dir, "spawner.mjs");
  await writeFile(
    script,
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n"),
  );
  const controller = new AbortController();
  const invocation = invokeCliSeat({
    seat: seat("cancel-tree-seat", process.execPath, [script]),
    prompt: "unused",
    cwd: dir,
    signal: controller.signal,
  });
  // Swallow the rejection here; asserted below via assert.rejects on the same promise object.
  invocation.catch(() => {});

  const grandchildPid = Number((await waitForFile(pidFile)).trim());
  assert.ok(isAlive(grandchildPid), "grandchild should be alive before cancellation");

  controller.abort(new Error("test cancellation"));
  await assert.rejects(() => invocation, CliCancelledError);

  const deadline = Date.now() + 5_000;
  while (isAlive(grandchildPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(isAlive(grandchildPid), false, "grandchild must be killed along with the direct child on cancellation");
});
