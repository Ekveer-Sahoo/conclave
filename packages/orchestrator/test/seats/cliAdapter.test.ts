import assert from "node:assert/strict";
import test from "node:test";
import { commandFor, invokeCliSeat, parseCommandCaptures, jsonObject, ProviderActionDeniedError, resultErrorSummary, seatCliOptions } from "../../src/seats/cliAdapter.ts";

const line = (obj: unknown) => JSON.stringify(obj);

test("parseCommandCaptures reconstructs a passing allowlisted command from a stream-json transcript", () => {
  const stdout = [
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "node --test" } }] },
    }),
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: "# pass 3\n# fail 0" }] },
    }),
    line({ type: "result", structured_output: { overall_verdict: "APPROVE" } }),
  ].join("\n");

  const captures = parseCommandCaptures(stdout, []);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].command, "node --test");
  assert.equal(captures[0].result, "PASS");
  assert.match(captures[0].output, /pass 3/);
});

test("parseCommandCaptures marks a failed tool_result as FAIL and extracts exit code", () => {
  const stdout = [
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "pnpm test" } }] },
    }),
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "command failed, exit code 1" }] },
    }),
  ].join("\n");

  const captures = parseCommandCaptures(stdout, []);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].result, "FAIL");
  assert.equal(captures[0].exitCode, 1);
});

test("parseCommandCaptures marks a denied command as DENIED using permission_denials", () => {
  const stdout = line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "git status" } }] },
  });
  const permissionDenials = [{ tool_name: "Bash", tool_use_id: "toolu_3", tool_input: { command: "git status" } }];

  const captures = parseCommandCaptures(stdout, permissionDenials);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].result, "DENIED");
});

test("parseCommandCaptures marks a command with no matching tool_result as INCONCLUSIVE", () => {
  const stdout = line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_4", name: "Bash", input: { command: "git diff" } }] },
  });

  const captures = parseCommandCaptures(stdout, []);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].result, "INCONCLUSIVE");
});

test("parseCommandCaptures drops commands not on the verification allowlist", () => {
  const stdout = [
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_5", name: "Bash", input: { command: "rm -rf /tmp/scratch" } }] },
    }),
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_5", is_error: false, content: "done" }] },
    }),
  ].join("\n");

  const captures = parseCommandCaptures(stdout, []);
  assert.equal(captures.length, 0);
});

test("parseCommandCaptures redacts secrets and truncates long output", () => {
  const longOutput = `token=sk-abcdefghijklmnopqrstuvwx ${"x".repeat(4100)}`;
  const stdout = [
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_6", name: "Bash", input: { command: "git log" } }] },
    }),
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_6", is_error: false, content: longOutput }] },
    }),
  ].join("\n");

  const captures = parseCommandCaptures(stdout, []);
  assert.equal(captures.length, 1);
  assert.doesNotMatch(captures[0].output, /sk-[A-Za-z0-9]{16,}/);
  assert.match(captures[0].output, /\[REDACTED\]/);
  assert.match(captures[0].output, /truncated/);
  assert.ok(captures[0].output.length < longOutput.length);
});

test("parseCommandCaptures never throws on malformed or non-JSON lines", () => {
  const stdout = ["not json at all", line({ type: "assistant", message: { content: "not-an-array" } }), ""].join("\n");
  assert.doesNotThrow(() => parseCommandCaptures(stdout, []));
});

test("jsonObject throws ProviderActionDeniedError when a provider denies a required action and returns no verdict", () => {
  const envelope = line({
    response: "",
    status: "SUCCESS",
    denied_actions: [{ action: "command", display_name: "RunCommand" }],
  });
  assert.throws(() => jsonObject(envelope), ProviderActionDeniedError);
});

test("jsonObject still extracts structured_output when no action was denied", () => {
  const envelope = line({ status: "SUCCESS", structured_output: { overall_verdict: "APPROVE" } });
  const { output } = jsonObject(envelope);
  assert.deepEqual(output, { overall_verdict: "APPROVE" });
});

test("parseCommandCaptures reads codex --json command_execution items, unwrapping the login-shell wrapper", () => {
  const item = (fields: Record<string, unknown>) => line({ type: "item.completed", item: { id: "item_1", type: "command_execution", ...fields } });
  const stdout = [
    line({ type: "thread.started", thread_id: "t" }),
    line({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'node --test a.test.js'", status: "in_progress" } }),
    item({ command: "bash -lc 'node --test a.test.js'", aggregated_output: "# pass 3", exit_code: 0, status: "completed" }),
    item({ command: "/bin/zsh -lc \"pnpm test\"", aggregated_output: "1 failing", exit_code: 1, status: "failed" }),
    item({ command: "bash -lc 'git status'", aggregated_output: "", status: "declined" }),
    // Not an allowlisted verification command: never captured as evidence.
    item({ command: "bash -lc 'curl https://example.com'", aggregated_output: "", exit_code: 0, status: "completed" }),
    line({ type: "item.completed", item: { id: "item_9", type: "agent_message", text: "{}" } }),
  ].join("\n");

  assert.deepEqual(
    parseCommandCaptures(stdout, []).map(({ command, result, exitCode }) => ({ command, result, exitCode })),
    [
      { command: "node --test a.test.js", result: "PASS", exitCode: 0 },
      { command: "pnpm test", result: "FAIL", exitCode: 1 },
      { command: "git status", result: "DENIED", exitCode: undefined },
    ],
  );
});

test("seatCliOptions carries a seat's configured model and extra flags, in that order", () => {
  const base = { id: "codex", label: "Codex", adapter: "cli" as const, cliCommand: "codex", role: "CORRECTNESS" as const, temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard" as const };
  assert.deepEqual(seatCliOptions(base), []);
  assert.deepEqual(seatCliOptions({ ...base, cliModel: "gpt-5.6-terra", cliExtraArgs: ["-c", "model_provider=openai"] }), ["--model", "gpt-5.6-terra", "-c", "model_provider=openai"]);
});

test("claude audits and votes pin a read-only permission mode instead of inheriting the operator's default", () => {
  const claude = { id: "claude", label: "Claude", adapter: "cli" as const, cliCommand: "claude", role: "ARCHITECTURE" as const, temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard" as const };
  const audit = commandFor(claude, "p", "audit").args;
  assert.equal(audit[audit.indexOf("--permission-mode") + 1], "dontAsk", "an operator default like \"auto\" must not approve edits during an audit");
  assert.ok(audit.includes("Read,Glob,Grep,Bash"), "no Edit/Write tools in an audit");
  const execute = commandFor(claude, "p", "execute").args;
  assert.equal(execute[execute.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("a permission denial is recorded as a DENIED command but does not void the seat's verdict", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "conclave-denial-"));
  const script = join(dir, "seat.mjs");
  writeFileSync(script, `console.log(JSON.stringify({
    type: "result",
    structured_output: { seat: "claude", findings: [], overall_verdict: "APPROVE", verdict_reasoning: "read it; could not run sed", raw_usage: { promptTokens: 1, completionTokens: 1 } },
    permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git status" } }],
  }));`);
  const seat = { id: "claude", label: "Claude", adapter: "cli" as const, cliCommand: process.execPath, cliArgsTemplate: [script, "{prompt}"], role: "ARCHITECTURE" as const, temperature: 0.2, maxTokens: 100, timeoutMs: 10_000, enabled: true, tier: "standard" as const };
  const outcome = await invokeCliSeat({ seat, prompt: "audit", cwd: dir });
  assert.equal(outcome.verdict.overall_verdict, "APPROVE");
  assert.deepEqual(outcome.commandRuns.map((run) => [run.command, run.result]), [["git status", "DENIED"]]);
});

test("a CLI that fails with nothing on stderr still explains itself: the error is read from its stdout result record", () => {
  const stdout = [
    line({ type: "assistant", message: { content: [] } }),
    line({ type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: ["Output does not match required schema"] }),
  ].join("\n");
  assert.equal(resultErrorSummary(stdout), "error_max_structured_output_retries: Output does not match required schema");
  assert.equal(resultErrorSummary(""), "(no output)");
  assert.equal(resultErrorSummary("plain failure text"), "plain failure text");
});
