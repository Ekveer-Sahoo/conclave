import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { SeatConfig } from "@conclave/core";
import { checkAllSeatHealth, checkSeatHealth, healthProbeArgs, suggestXeniaModels } from "../../dist/auth/authStatus.js";

const LISTED = [
  "cc/claude-haiku-4-5-20251001",
  "aug/gemini-3.1-pro-preview",
  "dva/gemini-3-1-pro-high",
  "dva/gemini-3-1-pro-low",
  "dva/claude-opus-4-7-max",
  "dva/grok-4-5-medium",
  "cx/gpt-5.6-sol",
];

const xeniaSeat = (over: Partial<SeatConfig> = {}): SeatConfig => ({
  id: "gemini", label: "Gemini", adapter: "xenia", xeniaModel: "cc/claude-haiku-4-5-20251001",
  role: "ARCHITECTURE", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard",
  ...over,
});
const fakeSeat: SeatConfig = { id: "fake-1", label: "Fake", adapter: "fake", role: "CORRECTNESS", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" };

interface Gateway { base: string; requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders }>; close: () => Promise<void> }

/**
 * Minimal stand-in for the gateway's model listing. Any other request (above all a chat
 * completion, which would spend tokens) is answered 500 and recorded so tests can assert on it.
 */
type GatewayReply = { status: number; body: string } | "hang" | undefined;
async function startGateway(handler?: (url: string, headers: IncomingHttpHeaders) => GatewayReply): Promise<Gateway> {
  const requests: Gateway["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const custom = handler?.(req.url ?? "", req.headers);
    if (custom === "hang") return;
    if (custom) { res.writeHead(custom.status, { "content-type": "application/json" }).end(custom.body); return; }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: LISTED.map((id) => ({ id, object: "model" })) }));
      return;
    }
    res.writeHead(500).end("unexpected request");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const KEY_ENV = "CONCLAVE_XENIA_API_KEY";
const BASE_ENV = "CONCLAVE_XENIA_BASE_URL";
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  apply(vars);
  try { return await fn(); } finally { apply(previous); }
}

test("xenia: a listed model is healthy, and only the model list is fetched (no tokens spent)", async () => {
  const gateway = await startGateway();
  try {
    const status = await withEnv({ [KEY_ENV]: undefined }, () => checkSeatHealth(xeniaSeat(), process.cwd(), 30_000, { xeniaBaseUrl: gateway.base }));
    assert.equal(status.healthy, true);
    assert.equal(status.binaryFound, true, "binaryFound means 'gateway reachable' for xenia seats");
    assert.equal(status.adapter, "xenia");
    assert.equal(status.seat, "gemini");
    assert.equal(status.cliCommand, "xenia:cc/claude-haiku-4-5-20251001");
    assert.match(status.detail, /no tokens spent/);
    assert.deepEqual(gateway.requests.map((r) => `${r.method} ${r.url}`), ["GET /v1/models"]);
    assert.equal(gateway.requests[0].headers.authorization, undefined, "no auth header without a key");
  } finally {
    await gateway.close();
  }
});

test("xenia: a missing model is unhealthy, names the model, and suggests close listed ids", async () => {
  const gateway = await startGateway();
  try {
    const status = await checkSeatHealth(xeniaSeat({ xeniaModel: "gemini/gemini-3.1-pro-preview" }), process.cwd(), 30_000, { xeniaBaseUrl: gateway.base });
    assert.equal(status.healthy, false);
    assert.equal(status.binaryFound, true);
    assert.match(status.detail, /model "gemini\/gemini-3\.1-pro-preview" is not listed/);
    assert.match(status.detail, /closest: aug\/gemini-3\.1-pro-preview, dva\/gemini-3-1-pro-(high|low), dva\/gemini-3-1-pro-(high|low)$/);
    assert.match(status.loginHint, new RegExp(`${gateway.base}/v1/models`));
    assert.match(status.loginHint, /CONCLAVE_XENIA_BASE_URL/);
    assert.match(status.loginHint, /CONCLAVE_XENIA_API_KEY/);
    assert.ok(gateway.requests.every((r) => r.method === "GET" && r.url === "/v1/models"));
  } finally {
    await gateway.close();
  }
});

test("xenia: a gateway that is down is reported as not reachable", async () => {
  const gateway = await startGateway();
  const base = gateway.base;
  await gateway.close();
  const status = await checkSeatHealth(xeniaSeat(), process.cwd(), 30_000, { xeniaBaseUrl: base });
  assert.equal(status.healthy, false);
  assert.equal(status.binaryFound, false, "unreachable gateway maps to MISSING for existing callers");
  assert.match(status.detail, new RegExp(`gateway not reachable at ${base}: ECONNREFUSED`));
});

test("xenia: a gateway that never answers times out quickly", async () => {
  const gateway = await startGateway(() => "hang");
  try {
    const started = Date.now();
    const status = await checkSeatHealth(xeniaSeat(), process.cwd(), 80, { xeniaBaseUrl: gateway.base });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(status.healthy, false);
    assert.equal(status.binaryFound, false);
    assert.match(status.detail, /did not answer within 80ms/);
  } finally {
    await gateway.close();
  }
});

test("xenia: the API key is sent as a bearer token, a 401 points at it, and the key is never echoed", async () => {
  const secret = "sk-health-do-not-echo";
  const gateway = await startGateway((url, headers) =>
    url === "/v1/models" && headers.authorization !== `Bearer ${secret}` ? { status: 401, body: JSON.stringify({ error: { message: "bad key" } }) } : undefined,
  );
  try {
    const ok = await withEnv({ [KEY_ENV]: secret }, () => checkSeatHealth(xeniaSeat(), process.cwd(), 30_000, { xeniaBaseUrl: gateway.base }));
    assert.equal(ok.healthy, true);
    assert.equal(gateway.requests[0].headers.authorization, `Bearer ${secret}`);

    const denied = await withEnv({ [KEY_ENV]: "wrong-key" }, () => checkSeatHealth(xeniaSeat(), process.cwd(), 30_000, { xeniaBaseUrl: gateway.base }));
    assert.equal(denied.healthy, false);
    assert.equal(denied.binaryFound, true, "the gateway answered, so it is reachable");
    assert.match(denied.detail, /gateway answered 401 for \/v1\/models \(check CONCLAVE_XENIA_API_KEY\)/);
    for (const text of [ok.detail, ok.loginHint, denied.detail, denied.loginHint]) {
      assert.doesNotMatch(text, /sk-health-do-not-echo|wrong-key/);
    }
  } finally {
    await gateway.close();
  }
});

test("xenia: an unrecognised listing body or a seat without a model is unhealthy but reachable", async () => {
  const gateway = await startGateway((url) => (url === "/v1/models" ? { status: 200, body: "{\"models\":[]}" } : undefined));
  try {
    const odd = await checkSeatHealth(xeniaSeat(), process.cwd(), 30_000, { xeniaBaseUrl: gateway.base });
    assert.equal(odd.healthy, false);
    assert.equal(odd.binaryFound, true);
    assert.match(odd.detail, /unrecognised \/v1\/models body/);
  } finally {
    await gateway.close();
  }
  const listing = await startGateway();
  try {
    const noModel = await checkSeatHealth(xeniaSeat({ xeniaModel: undefined }), process.cwd(), 30_000, { xeniaBaseUrl: listing.base });
    assert.equal(noModel.healthy, false);
    assert.equal(noModel.binaryFound, true);
    assert.match(noModel.detail, /no xeniaModel configured/);
    assert.equal(noModel.cliCommand, "xenia:(no model)");
  } finally {
    await listing.close();
  }
});

test("fake: always healthy without contacting any provider", async () => {
  const status = await checkSeatHealth(fakeSeat, process.cwd());
  assert.deepEqual(
    { healthy: status.healthy, binaryFound: status.binaryFound, adapter: status.adapter, detail: status.detail, seat: status.seat },
    { healthy: true, binaryFound: true, adapter: "fake", detail: "in-process fake seat (no provider)", seat: "fake-1" },
  );
});

test("checkAllSeatHealth resolves the gateway from CONCLAVE_XENIA_BASE_URL, like the adapter, and dispatches per adapter", async () => {
  const gateway = await startGateway();
  try {
    const results = await withEnv({ [BASE_ENV]: `${gateway.base}/`, [KEY_ENV]: undefined }, () =>
      checkAllSeatHealth([xeniaSeat(), xeniaSeat({ id: "grok", xeniaModel: "xai/grok-4.3" }), fakeSeat], process.cwd()),
    );
    assert.deepEqual(results.map((r) => [r.seat, r.adapter, r.healthy]), [["gemini", "xenia", true], ["grok", "xenia", false], ["fake-1", "fake", true]]);
    assert.match(results[1].detail, /closest: dva\/grok-4-5-medium/);
    assert.equal(gateway.requests.length, 2, "one listing per xenia seat; the fake seat makes no request");
  } finally {
    await gateway.close();
  }
});

test("suggestions need a shared family token, not just a tier word or a number", () => {
  assert.deepEqual(suggestXeniaModels("alibaba/qwen3.7-max", LISTED), [], "'max' alone must not suggest dva/claude-opus-4-7-max");
  assert.deepEqual(suggestXeniaModels("xai/grok-4.3", LISTED), ["dva/grok-4-5-medium"]);
  assert.deepEqual(suggestXeniaModels("openai/gpt-5.6", LISTED), ["cx/gpt-5.6-sol"]);
  assert.equal(suggestXeniaModels("gemini/gemini-3.1-pro-preview", LISTED)[0], "aug/gemini-3.1-pro-preview");
  assert.ok(suggestXeniaModels("gemini/gemini-3.1-pro-preview", LISTED).length <= 3);
});

test("the CLI login probe uses the seat's configured model and flags, so doctor judges a seat the way a run will use it", () => {
  const seat = (id: string, extra: Partial<SeatConfig> = {}): SeatConfig => ({ id, label: id, adapter: "cli", cliCommand: id, role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard", ...extra });
  assert.deepEqual(healthProbeArgs(seat("claude", { cliModel: "claude-sonnet-5" })).slice(-2), ["--model", "claude-sonnet-5"]);
  const codex = healthProbeArgs(seat("codex", { cliModel: "gpt-5.6-terra", cliExtraArgs: ["-c", "model_provider=openai"] }));
  // --skip-git-repo-check: doctor and the web server can run outside any git repository.
  assert.deepEqual(codex, ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "--model", "gpt-5.6-terra", "-c", "model_provider=openai", "Reply exactly OK"], "codex's prompt must stay the final positional argument");
  assert.equal(healthProbeArgs(seat("claude")).includes("--model"), false, "no configured model means the CLI's own default, as before");
});
