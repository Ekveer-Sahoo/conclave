import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SeatConfig } from "@conclave/core";
import { CliInvocationError, commandFor, extractProviderUsage, extractReportedModel, invokeCliSeat, jsonObject } from "../../dist/seats/cliAdapter.js";
import { applyModelOverrides, modelCatalog } from "../../dist/seats/modelCatalog.js";
import { xeniaBaseUrl } from "../../dist/seats/xeniaAdapter.js";
import { SeatConfigConflictError, SeatConfigInvalidError, SeatConfigStore } from "../../dist/http/seatConfigStore.js";

// Regression tests for defects found by the multi-agent bug hunt. Each one failed before its fix.

const cliSeat = (id: string, extra: Partial<SeatConfig> = {}): SeatConfig => ({
  id, label: id, adapter: "cli", cliCommand: id, role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 5_000, enabled: true, tier: "standard", ...extra,
});

/** An executable in its own directory, named `name`, running `body` as a Node script. */
function fakeCli(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conclave-fakecli-"));
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const VERDICT = { seat: "x", findings: [], overall_verdict: "APPROVE", verdict_reasoning: "fine" };

test("a prompt reaches a template seat verbatim, $-patterns and all", () => {
  const seat = cliSeat("custom", { cliArgsTemplate: ["--ask", "{prompt}"] });
  const prompt = "echo \"pid=$$\" and '$&!' and printf $'a\\tb' and $` $'";
  assert.equal(commandFor(seat, prompt, "audit").args[1], prompt);
});

test("a codex verdict wrapped in a code fence or prose is parsed, not rejected as malformed", () => {
  const message = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const fenced = jsonObject(message("```json\n" + JSON.stringify(VERDICT) + "\n```"));
  assert.equal((fenced.output as typeof VERDICT).overall_verdict, "APPROVE");
  const prose = jsonObject(message(`Here is my verdict: ${JSON.stringify(VERDICT)} — done.`));
  assert.equal((prose.output as typeof VERDICT).verdict_reasoning, "fine");
});

test("a seat renamed but still driving codex is invoked, metered and probed as codex", () => {
  const seat = cliSeat("codex-mini", { cliCommand: "/opt/bin/codex", cliModel: "gpt-6-mini" });
  const { args } = commandFor(seat, "PROMPT", "audit");
  assert.deepEqual(args.slice(0, 3), ["exec", "--sandbox", "read-only"]);
  const envelope = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(extractProviderUsage(seat, envelope)?.promptTokens, 10);
});

test("a failed CLI call still carries its reported usage, and its stderr is redacted and bounded", async () => {
  const codex = fakeCli("codex", [
    `console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, output_tokens: 300 } }));`,
    `process.stderr.write("x".repeat(100000) + " OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\\n");`,
    `process.exit(1);`,
  ].join("\n"));
  const error = await invokeCliSeat({ seat: cliSeat("codex", { cliCommand: codex }), prompt: "p", cwd: tmpdir() }).then(
    () => assert.fail("expected the call to fail"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof CliInvocationError);
  assert.equal(error.usage?.promptTokens, 2000, "the provider billed the failed call; the budget must see it");
  assert.ok(!error.message.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(error.message.length < 3_000, `bounded, got ${error.message.length} chars`);
});

test("a seat timeout above setTimeout's range does not fire immediately", async () => {
  const claude = fakeCli("claude", `console.log(JSON.stringify({ type: "result", structured_output: ${JSON.stringify(VERDICT)} }));`);
  const outcome = await invokeCliSeat({ seat: cliSeat("claude", { cliCommand: claude, timeoutMs: 3_000_000_000 }), prompt: "p", cwd: tmpdir() });
  assert.equal(outcome.verdict.overall_verdict, "APPROVE");
});

test("the reported model is the one that wrote the answer, not the first key of modelUsage", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }),
    JSON.stringify({ type: "result", modelUsage: { "claude-haiku-4-5-20251001": { outputTokens: 12 }, "claude-opus-5-5": { outputTokens: 900 } } }),
  ].join("\n");
  assert.equal(extractReportedModel(stdout), "claude-opus-5-5");
  const resultOnly = JSON.stringify({ type: "result", modelUsage: { "claude-haiku-4-5-20251001": { outputTokens: 12 }, "claude-opus-5-5": { outputTokens: 900 } } });
  assert.equal(extractReportedModel(resultOnly), "claude-opus-5-5", "without assistant records, the model that wrote the most");
});

test("Claude's cache-creation tokens count as prompt tokens", () => {
  const envelope = JSON.stringify({ type: "result", usage: { input_tokens: 9, cache_creation_input_tokens: 204_000, cache_read_input_tokens: 180_000, output_tokens: 50 }, total_cost_usd: 0.8 });
  const usage = extractProviderUsage("claude", envelope);
  assert.equal(usage?.promptTokens, 204_009);
  assert.equal(usage?.cachedInputTokens, 180_000);
});

test("an OpenAI-style gateway base URL ending in /v1 is not doubled", () => {
  assert.equal(xeniaBaseUrl("http://localhost:20128/v1"), "http://localhost:20128");
  assert.equal(xeniaBaseUrl("http://localhost:20128/v1/"), "http://localhost:20128");
  assert.equal(xeniaBaseUrl("http://localhost:20128"), "http://localhost:20128");
});

test("seat ids that are Object property names are ordinary seats", () => {
  const seats = [cliSeat("toString"), cliSeat("constructor")];
  assert.deepEqual(applyModelOverrides(seats, {}), seats);
  assert.equal(applyModelOverrides(seats, { toString: "m1" })[0]!.cliModel, "m1");
});

test("Codex's config is read as Codex reads it: quotes, profiles, commented headers, and the seat's own -c flags", async () => {
  const home = mkdtempSync(join(tmpdir(), "conclave-codexhome-"));
  writeFileSync(
    join(home, "config.toml"),
    [`model = 'top-model'`, `profile = "fast"`, `model_provider = "gw"`, "", "[profiles.fast] # the quick one", `model = "profile-model"`, "", "[model_providers.gw]  # gateway", `base_url = "http://127.0.0.1:9/v1"`, ""].join("\n"),
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const viaProfile = await modelCatalog(cliSeat("codex"), { fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "gpt-6-sol" }] }))) as typeof fetch });
    assert.equal(viaProfile.defaultModel, "profile-model", "the active profile's model wins over the top level");
    assert.match(viaProfile.source, /127\.0\.0\.1:9/, "a table header with a trailing comment is still found");
    const direct = await modelCatalog(cliSeat("codex", { cliExtraArgs: ["-c", "model_provider=openai", "-c", 'model="flag-model"'] }));
    assert.equal(direct.defaultModel, "flag-model");
    assert.doesNotMatch(direct.source, /127\.0\.0\.1/, "a seat that bypasses the gateway does not get the gateway's list");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

const storePath = () => join(mkdtempSync(join(tmpdir(), "conclave-seatcfg-")), "seat-config.json");
const fakeSeat = (id: string) => ({ id, label: id, adapter: "fake" as const, role: "CORRECTNESS" as const, temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard" as const });

test("the seat store never overwrites an invalid file unless told to, and then keeps a backup", () => {
  const path = storePath();
  writeFileSync(path, JSON.stringify({ version: 12, seats: [{ ...fakeSeat("claude"), timeoutMs: "120000" }] }));
  const store = new SeatConfigStore(path);
  assert.ok(store.problem());
  assert.throws(() => store.save([fakeSeat("claude")]), SeatConfigInvalidError);
  assert.match(readFileSync(path, "utf8"), /"120000"/, "nothing was written");
  const saved = store.save([fakeSeat("claude")], { replaceInvalid: true });
  assert.equal(saved.version, 13, "the version keeps going up from the invalid file's");
  assert.equal(readdirSync(join(path, "..")).filter((name) => name.includes(".invalid-")).length, 1, "the invalid file is kept");
});

test("the seat store sees saves made by another process, and refuses a save based on a stale version", () => {
  const path = storePath();
  const server = new SeatConfigStore(path);
  const cli = new SeatConfigStore(path);
  server.save([fakeSeat("claude")]);
  const read = server.get().version;
  cli.save([fakeSeat("claude"), fakeSeat("codex")], { expectedVersion: cli.get().version });
  assert.deepEqual(server.get().seats.map((seat) => seat.id), ["claude", "codex"], "the other process's change is visible");
  assert.throws(() => server.save([fakeSeat("claude")], { expectedVersion: read }), SeatConfigConflictError);
});

test("the seat store validates what it saves, and reports unknown settings instead of dropping them silently", () => {
  const path = storePath();
  const store = new SeatConfigStore(path);
  assert.throws(() => store.save([{ ...fakeSeat("claude"), cliModel: 5 } as unknown as SeatConfig]));
  assert.equal(existsSync(path), false, "an invalid config is never written");
  writeFileSync(path, JSON.stringify({ version: 1, seats: [{ ...fakeSeat("codex"), cliModle: "gpt-6-sol" }] }));
  assert.match(new SeatConfigStore(path).warnings().join(" "), /cliModle/);
});
