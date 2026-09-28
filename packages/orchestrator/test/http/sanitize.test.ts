import assert from "node:assert/strict";
import test from "node:test";
import { toClientMessage } from "../../src/http/sanitize.ts";
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
  assert.ok(activityOut.text.includes("<path>"));

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
