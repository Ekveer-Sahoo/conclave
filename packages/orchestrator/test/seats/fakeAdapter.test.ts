import assert from "node:assert/strict";
import test from "node:test";
import type { SeatConfig } from "@conclave/core";
import { clearFakeSeats, invokeFakeSeat, registerFakeSeat, scriptFakeSeat } from "../../dist/seats/fakeAdapter.js";

const seat = (id: string, adapter: SeatConfig["adapter"] = "fake"): SeatConfig => ({
  id, label: id, adapter, role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 1_000, enabled: true, tier: "standard",
});
const invoke = (id: string, over: Partial<Parameters<typeof invokeFakeSeat>[0]> = {}) =>
  invokeFakeSeat({ seat: seat(id), prompt: "p", cwd: "/tmp", mode: "audit", ...over });

test("an unregistered fake seat approves, so a fake council needs no setup", async (t) => {
  t.after(clearFakeSeats);
  const { verdict, usage } = await invoke("solo");
  assert.equal(verdict.overall_verdict, "APPROVE");
  assert.equal(verdict.seat, "solo");
  assert.deepEqual(verdict.findings, []);
  assert.equal(usage?.costUsd, 0, "a fake seat spends nothing, and says so rather than reporting unknown");
});

test("the seat id always comes from configuration, never from the scripted response", async (t) => {
  t.after(clearFakeSeats);
  registerFakeSeat("real", () => ({ kind: "verdict", verdict: { seat: "impostor", overall_verdict: "APPROVE" } }));
  const { verdict } = await invoke("real");
  assert.equal(verdict.seat, "real", "a provider must not be able to claim it is a different seat");
});

test("scripted responses are consumed in order and the last one repeats", async (t) => {
  t.after(clearFakeSeats);
  scriptFakeSeat("s", [
    { kind: "verdict", verdict: { overall_verdict: "REJECT", verdict_reasoning: "first" } },
    { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: "second" } },
  ]);
  assert.equal((await invoke("s")).verdict.overall_verdict, "REJECT");
  assert.equal((await invoke("s")).verdict.overall_verdict, "APPROVE");
  assert.equal((await invoke("s")).verdict.overall_verdict, "APPROVE", "the final response repeats once the script runs out");
});

test("a scripted error rejects like a provider that failed", async (t) => {
  t.after(clearFakeSeats);
  scriptFakeSeat("broken", [{ kind: "error", message: "provider exploded" }]);
  await assert.rejects(() => invoke("broken"), /provider exploded/);
});

test("a hanging seat rejects as cancelled once the signal aborts", async (t) => {
  t.after(clearFakeSeats);
  scriptFakeSeat("stuck", [{ kind: "hang" }]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => invoke("stuck", { signal: controller.signal }), /cancelled/);
});

test("an already-aborted signal is refused before any work happens", async (t) => {
  t.after(clearFakeSeats);
  await assert.rejects(() => invoke("any", { signal: AbortSignal.abort() }), /cancelled before invocation/);
});

test("a non-fake seat is refused rather than silently handled", async () => {
  await assert.rejects(
    () => invokeFakeSeat({ seat: seat("cli-seat", "cli"), prompt: "p", cwd: "/tmp", mode: "audit" }),
    /not a fake adapter/,
  );
});

test("scripted findings survive schema validation and reach the caller", async (t) => {
  t.after(clearFakeSeats);
  scriptFakeSeat("finder", [{
    kind: "verdict",
    verdict: {
      overall_verdict: "REJECT",
      findings: [{ id: "f1", seat: "finder", role: "SECURITY", target: "src/a.ts", category: "authz", severity: "BLOCKER", description: "missing check", falsifiable_test: null, confidence: 0.9 }],
    },
  }]);
  const { verdict } = await invoke("finder");
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.findings[0].severity, "BLOCKER");
});
