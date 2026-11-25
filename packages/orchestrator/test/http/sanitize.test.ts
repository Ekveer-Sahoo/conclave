import assert from "node:assert/strict";
import test from "node:test";
import { toClientMessage } from "../../dist/http/sanitize.js";
import type { SessionMessage } from "../../src/session/autonomousCouncil.ts";

function activityMessage(text: string): SessionMessage {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    kind: "activity",
    activity: { at: new Date().toISOString(), kind: "system", message: text },
  };
}

function userMessage(text: string): SessionMessage {
  return { seq: 1, ts: new Date().toISOString(), kind: "user", text } as SessionMessage;
}

test("redacts AWS-style access keys from browser-facing text", () => {
  const out = toClientMessage(activityMessage("found key AKIAABCDEFGHIJKLMNOP in .env"), []);
  assert.ok(!out.text.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(out.text.includes("[redacted]"));
});

test("redacts PEM-style private key blocks", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
  const out = toClientMessage(activityMessage(`before ${pem} after`), []);
  assert.ok(!out.text.includes("MIIBOgIBAAJBAK"));
  assert.ok(out.text.includes("[redacted]"));
});

test("redacts sk-/pk-/rk- style API tokens", () => {
  const out = toClientMessage(activityMessage("Authorization used sk-abcdefghijklmnopqrstuvwx"), []);
  assert.ok(!out.text.includes("sk-abcdefghijklmnopqrstuvwx"));
});

test("redacts key=value style secrets regardless of casing or separator", () => {
  const out = toClientMessage(activityMessage("password: hunter2live API_KEY=xyz789 token=abc.def.ghi"), []);
  assert.ok(!out.text.includes("hunter2live"));
  assert.ok(!out.text.includes("xyz789"));
  assert.ok(!out.text.includes("abc.def.ghi"));
});

test("redacts absolute filesystem paths outside the selected repository on both user and activity messages", () => {
  const secretPath = "/Users/someone/.ssh/id_rsa";
  const activityOut = toClientMessage(activityMessage(`reading ${secretPath} for context`), [secretPath]);
  assert.ok(!activityOut.text.includes(secretPath));
  assert.ok(activityOut.text.includes("[path]"));

  const userOut = toClientMessage(userMessage(`please check ${secretPath}`), [secretPath]);
  assert.ok(!userOut.text.includes(secretPath));
});

test("does not redact short or empty path strings — avoids corrupting ordinary text", () => {
  const out = toClientMessage(activityMessage("the value was ok"), ["", "/a"]);
  assert.equal(out.text, "the value was ok");
});

test("truncates overlong text with a visible marker instead of shipping unbounded payloads to the browser", () => {
  const huge = "x".repeat(10_000);
  const out = toClientMessage(activityMessage(huge), []);
  assert.ok(out.text.length < huge.length);
  assert.ok(out.text.endsWith("[truncated]"));
});

test("activity messages never leak the raw activity object shape beyond the documented ClientMessage fields", () => {
  const out = toClientMessage(activityMessage("normal status text"), []);
  assert.deepEqual(Object.keys(out).sort(), ["activityKind", "kind", "phase", "round", "seat", "seq", "text", "ts", "verdict"]);
});

test("redacts prefixed env-style keys, JSON keys, bearer tokens and vendor tokens", () => {
  const secrets = [
    "OPENAI_API_KEY=sk-live-0123456789abcdefghij",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
    "GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuv",
    '{"api_key": "hunter2-but-longer"}',
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    "slack xoxb-1234567890-abcdefghij",
  ];
  for (const secret of secrets) {
    const out = toClientMessage(activityMessage(`found ${secret} in logs`), []).text;
    for (const part of ["sk-live-0123456789abcdefghij", "wJalrXUtnFEMI", "ghp_0123456789", "hunter2", "eyJhbGciOiJIUzI1NiJ9", "xoxb-1234567890"]) {
      assert.ok(!out.includes(part), `${secret} leaked as: ${out}`);
    }
  }
  assert.equal(toClientMessage(activityMessage("prompt tokens: 1200, completion tokens=300"), []).text, "prompt tokens: 1200, completion tokens=300", "a token count is not a secret");
});

test("a seat's verdict reaches the browser redacted and capped like its text", () => {
  const message = activityMessage("reviewed");
  (message as { activity: { verdict?: unknown } }).activity.verdict = {
    overall_verdict: "REJECT",
    verdict_reasoning: "see /home/alice/repo/src/a.ts",
    findings: [{ id: "codex:F1", seat: "codex", role: "SECURITY", target: "/home/alice/repo/src/a.ts", category: "leak", severity: "BLOCKER", description: `key AKIAIOSFODNN7EXAMPLE ${"x".repeat(10_000)}`, falsifiable_test: null, confidence: 0.9 }],
  };
  const out = toClientMessage(message, [{ path: "/home/alice/repo", label: "repository" }]);
  const verdict = out.verdict as { overall_verdict: string; findings: Array<{ target: string; description: string }>; verdict_reasoning?: string };
  assert.equal(verdict.overall_verdict, "REJECT");
  assert.equal(verdict.findings[0]!.target, "[repository]/src/a.ts");
  assert.ok(!verdict.findings[0]!.description.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(verdict.findings[0]!.description.length < 5_000);
  assert.equal(verdict.verdict_reasoning, undefined, "the reasoning is the message text, already sent redacted");
});
