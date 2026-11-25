import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractProviderUsage } from "../../dist/seats/cliAdapter.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

const line = (obj: unknown) => JSON.stringify(obj);

test("extractProviderUsage parses a real captured Claude result envelope", () => {
  const usage = extractProviderUsage("claude", fixture("claude-envelope.jsonl"));
  assert.deepEqual(usage, {
    promptTokens: 2,
    completionTokens: 4,
    cachedInputTokens: 68814,
    costUsd: 0.0138068,
    source: "claude_envelope",
  });
});

test("extractProviderUsage parses a real captured Codex turn.completed envelope", () => {
  const usage = extractProviderUsage("codex", fixture("codex-envelope.jsonl"));
  assert.deepEqual(usage, {
    promptTokens: 16744,
    completionTokens: 5,
    cachedInputTokens: 0,
    source: "codex_envelope",
  });
});

test("extractProviderUsage parses a real captured Antigravity envelope", () => {
  const usage = extractProviderUsage("antigravity", fixture("antigravity-envelope.jsonl"));
  assert.deepEqual(usage, {
    promptTokens: 13855,
    completionTokens: 273,
    cachedInputTokens: 8119,
    source: "antigravity_envelope",
  });
});

test("extractProviderUsage returns null for an unknown seat id", () => {
  assert.equal(extractProviderUsage("unknown-seat", fixture("claude-envelope.jsonl")), null);
});

test("extractProviderUsage returns null when the envelope is entirely non-JSON", () => {
  assert.equal(extractProviderUsage("claude", "not json at all\nalso not json"), null);
});

test("extractProviderUsage returns null when the result line is missing", () => {
  const stdout = line({ type: "assistant", message: { content: [] } });
  assert.equal(extractProviderUsage("claude", stdout), null);
});

test("extractProviderUsage returns null when the result line has no usage field", () => {
  const stdout = line({ type: "result", subtype: "success", total_cost_usd: 0.01 });
  assert.equal(extractProviderUsage("claude", stdout), null);
});

test("extractProviderUsage returns null when usage token fields are missing", () => {
  const stdout = line({ type: "turn.completed", usage: { cached_input_tokens: 0 } });
  assert.equal(extractProviderUsage("codex", stdout), null);
});

test("extractProviderUsage rejects negative token counts", () => {
  const stdout = line({ type: "result", usage: { input_tokens: -5, output_tokens: 4 } });
  assert.equal(extractProviderUsage("claude", stdout), null);
});

test("extractProviderUsage rejects fractional token counts", () => {
  const stdout = line({ type: "result", usage: { input_tokens: 2.5, output_tokens: 4 } });
  assert.equal(extractProviderUsage("claude", stdout), null);
});

test("extractProviderUsage rejects non-finite token counts", () => {
  const stdout = line({ type: "result", usage: { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 4 } });
  assert.equal(extractProviderUsage("claude", stdout), null);
});

test("extractProviderUsage rejects implausibly large token counts", () => {
  const stdout = line({ type: "result", usage: { input_tokens: 50_000_000, output_tokens: 4 } });
  assert.equal(extractProviderUsage("claude", stdout), null);
});

test("extractProviderUsage rejects implausibly large or negative cost and drops it rather than the usage", () => {
  const stdout = line({ type: "result", total_cost_usd: -1, usage: { input_tokens: 2, output_tokens: 4 } });
  const usage = extractProviderUsage("claude", stdout);
  assert.ok(usage);
  assert.equal(usage?.costUsd, undefined);
  assert.equal(usage?.promptTokens, 2);
});

test("extractProviderUsage returns null for Antigravity when the envelope unexpectedly carries a type field", () => {
  const stdout = line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(extractProviderUsage("antigravity", stdout), null);
});

test("extractProviderUsage never throws on malformed or truncated envelopes", () => {
  const stdout = ["{not json", line({ type: "result" }), ""].join("\n");
  assert.doesNotThrow(() => extractProviderUsage("claude", stdout));
  assert.doesNotThrow(() => extractProviderUsage("codex", stdout));
  assert.doesNotThrow(() => extractProviderUsage("antigravity", stdout));
});
