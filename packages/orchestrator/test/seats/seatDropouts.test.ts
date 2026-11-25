import assert from "node:assert/strict";
import { test } from "node:test";
import { CliCancelledError, CliInvocationError, ProviderActionDeniedError, isTransientCliFailure, jsonObject } from "../../dist/seats/cliAdapter.js";

test("a Codex turn that completes with no agent message is reported as blocked, not as a JSON syntax error", () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
  ].join("\n");
  assert.throws(() => jsonObject(stdout), (error: unknown) => error instanceof ProviderActionDeniedError && /without writing any answer/.test((error as Error).message));
});

test("a Codex turn with an agent message still yields its verdict", () => {
  const verdict = { findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok" };
  const stdout = [
    '{"type":"turn.started"}',
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } }),
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
  ].join("\n");
  assert.deepEqual(jsonObject(stdout).output, verdict);
});

test("only provider-side transient exits are retried", () => {
  assert.equal(isTransientCliFailure(new CliInvocationError("antigravity", "exited 3: error: NOT_FOUND (code 404): Requested entity was not found.")), true);
  assert.equal(isTransientCliFailure(new CliInvocationError("codex", "exited 1: 429 Too Many Requests (code 429)")), true);
  assert.equal(isTransientCliFailure(new CliInvocationError("claude", "timed out after 1800000ms")), false);
  assert.equal(isTransientCliFailure(new CliInvocationError("claude", "exited 1: Not logged in")), false);
  assert.equal(isTransientCliFailure(new CliCancelledError("claude", "cancelled")), false);
  assert.equal(isTransientCliFailure(new Error("NOT_FOUND")), false);
});
