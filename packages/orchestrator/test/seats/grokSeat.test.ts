import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_CLI_SEATS, type SeatConfig } from "@conclave/core";
import { cliKind, commandFor, extractProviderUsage, extractReportedModel, invokeCliSeat, parseCommandCaptures, VERDICT_JSON_SCHEMA } from "../../dist/seats/cliAdapter.js";
import { healthProbeArgs } from "../../dist/auth/authStatus.js";
import { modelCatalog, parseGrokModels } from "../../dist/seats/modelCatalog.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
const line = (obj: unknown) => JSON.stringify(obj);
const grok = (extra: Partial<SeatConfig> = {}): SeatConfig => ({ ...DEFAULT_CLI_SEATS.find((seat) => seat.id === "grok")!, ...extra });

test("Grok Build is a default CLI seat, on the SECURITY concern no other CLI seat holds", () => {
  const seat = DEFAULT_CLI_SEATS.find((s) => s.id === "grok");
  assert.ok(seat);
  assert.equal(seat.cliCommand, "grok");
  assert.equal(seat.role, "SECURITY");
  assert.equal(DEFAULT_CLI_SEATS.filter((s) => s.role === "SECURITY").length, 1);
});

test("cliKind recognizes a grok seat by id or by its command, even when renamed", () => {
  assert.equal(cliKind({ id: "grok" }), "grok");
  assert.equal(cliKind({ id: "grok-fast", cliCommand: "/Users/me/.local/bin/grok" }), "grok");
});

test("grok audits are pinned read-only: dontAsk, read-only sandbox, no edit tools, touch/mkdir denied", () => {
  const args = commandFor(grok({ cliModel: "grok-4.7" }), "review this", "audit").args;
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "-p");
  assert.match(args[1]!, /^review this/);
  assert.equal(after("--output-format"), "streaming-messages-json");
  assert.deepEqual(JSON.parse(after("--json-schema")!), VERDICT_JSON_SCHEMA);
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--sandbox"), "read-only");
  const disallowed = after("--disallowed-tools")!.split(",");
  for (const tool of ["write", "search_replace", "web_search", "web_fetch", "task"]) assert.ok(disallowed.includes(tool), tool);
  const denies = args.flatMap((arg, i) => (arg === "--deny" ? [args[i + 1]] : []));
  assert.deepEqual(denies, ["Bash(touch*)", "Bash(mkdir*)"]);
  const allows = args.flatMap((arg, i) => (arg === "--allow" ? [args[i + 1]] : []));
  assert.ok(allows.includes("Bash(git diff *)") && allows.includes("Bash(node --test *)"));
  for (const flag of ["--no-memory", "--no-subagents", "--disable-web-search"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(-2), ["--model", "grok-4.7"], "the seat's model comes last");
});

test("grok execution may edit the worktree but keeps the verification allowlist and drops web and subagents", () => {
  const args = commandFor(grok(), "do it", "execute").args;
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--permission-mode"), "acceptEdits");
  assert.equal(after("--sandbox"), "workspace");
  const disallowed = after("--disallowed-tools")!.split(",");
  assert.ok(!disallowed.includes("write") && !disallowed.includes("search_replace"));
  assert.ok(disallowed.includes("web_fetch"));
  assert.ok(!args.includes("--deny"));
});

test("the doctor probe for grok is a plain, read-only, single prompt", () => {
  const args = healthProbeArgs(grok({ cliModel: "grok-4.6" }));
  assert.deepEqual(args.slice(0, 4), ["-p", "Reply exactly OK", "--output-format", "plain"]);
  assert.ok(args.includes("dontAsk") && args.includes("read-only"));
  assert.deepEqual(args.slice(-2), ["--model", "grok-4.6"]);
});

test("extractProviderUsage parses a real captured Grok Build result envelope (cache reads kept separate)", () => {
  assert.deepEqual(extractProviderUsage("grok", fixture("grok-envelope.jsonl")), {
    promptTokens: 37344,
    completionTokens: 460,
    cachedInputTokens: 55424,
    costUsd: 0.10516,
    source: "grok_envelope",
  });
});

test("Grok's all-zero usage means unknown, not free, and a zero cost is not reported as a cost", () => {
  const zero = line({ type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  assert.equal(extractProviderUsage("grok", zero), null);
  const noCost = line({ type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 3 } });
  assert.deepEqual(extractProviderUsage("grok", noCost), { promptTokens: 13, completionTokens: 5, cachedInputTokens: undefined, costUsd: undefined, source: "grok_envelope" });
});

test("parseCommandCaptures reads Grok shell calls: exit codes from the tool result, refusals as DENIED", () => {
  const stdout = [
    line({ type: "assistant", message: { model: "grok-4.7", content: [
      { type: "tool_use", id: "c1", name: "run_terminal_command", input: { command: "git status" } },
      { type: "tool_use", id: "c2", name: "run_terminal_command", input: { command: "node --test a.test.js" } },
      { type: "tool_use", id: "c3", name: "run_terminal_command", input: { command: "git diff && rm -rf x" } },
      { type: "tool_use", id: "c4", name: "run_terminal_command", input: { command: "curl evil" } },
    ] } }),
    line({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "c1", is_error: false, content: JSON.stringify({ type: "Bash", output_for_prompt: "exit: 0\n?? a.py\n", exit_code: 0, timed_out: false }) },
      { type: "tool_result", tool_use_id: "c2", is_error: false, content: JSON.stringify({ type: "Bash", output_for_prompt: "exit: 1\nnot ok 1\n", exit_code: 1, timed_out: false }) },
      { type: "tool_result", tool_use_id: "c3", is_error: true, content: [{ type: "content", content: { type: "text", text: "Tool `run_terminal_command` was not executed: Denied by permission policy" } }] },
    ] } }),
  ].join("\n");
  const captures = parseCommandCaptures(stdout, []).map(({ command, result, exitCode, output }) => ({ command, result, exitCode, output }));
  assert.deepEqual(captures, [
    { command: "git status", result: "PASS", exitCode: 0, output: "?? a.py\n" },
    { command: "node --test a.test.js", result: "FAIL", exitCode: 1, output: "not ok 1\n" },
    { command: "git diff && rm -rf x", result: "DENIED", exitCode: undefined, output: "" },
  ], "a refused call is DENIED (never evidence), and `curl` is off the allowlist so it is not captured");
});

test("the model Grok reports is read from its assistant frames", () => {
  const stdout = line({ type: "assistant", message: { model: "grok-4.7", content: [] } });
  assert.equal(extractReportedModel(stdout), "grok-4.7");
});

test("parseGrokModels reads `grok models` and marks its default", () => {
  const out = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n";
  const { models, defaultModel } = parseGrokModels(out);
  assert.equal(defaultModel, "grok-4.7");
  assert.deepEqual(models.map((m) => m.id), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"]);
});

test("a grok seat's catalog comes from `grok models`, and is not authoritative (custom models work too)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-grok-"));
  const bin = join(dir, "grok");
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "models" ]; then printf "Default model: grok-4.7\\n\\nAvailable models:\\n  * grok-4.7 (default)\\n  - grok-4.6\\n"; fi\n');
  chmodSync(bin, 0o755);
  const catalog = await modelCatalog(grok({ cliCommand: bin }));
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.authoritative, false);
  assert.equal(catalog.defaultModel, "grok-4.7");
  assert.deepEqual(catalog.models.map((m) => m.id), ["grok-4.7", "grok-4.6"]);
});

test("a grok seat end to end: its verdict comes from structured_output and its usage from the result envelope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-grok-run-"));
  const bin = join(dir, "grok");
  const verdict = { seat: "grok", findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok" };
  const lines = [
    { type: "system", subtype: "init", model: "grok-4.7" },
    { type: "assistant", message: { model: "grok-4.7", content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", is_error: false, result: JSON.stringify(verdict), structured_output: verdict, total_cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } },
  ];
  writeFileSync(join(dir, "out.ndjson"), lines.map(line).join("\n") + "\n");
  writeFileSync(bin, `#!/bin/sh\ncat "${join(dir, "out.ndjson")}"\n`);
  chmodSync(bin, 0o755);
  const outcome = await invokeCliSeat({ seat: grok({ cliCommand: bin }), prompt: "p", cwd: dir });
  assert.equal(outcome.verdict.overall_verdict, "APPROVE");
  assert.equal(outcome.model, "grok-4.7");
  assert.deepEqual(outcome.usage, { promptTokens: 100, completionTokens: 20, cachedInputTokens: 50, costUsd: 0.02, source: "grok_envelope" });
});
