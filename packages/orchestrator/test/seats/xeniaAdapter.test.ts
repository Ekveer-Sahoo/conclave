import assert from "node:assert/strict";
import test from "node:test";
import type { SeatConfig } from "@conclave/core";
import { CliCancelledError } from "../../dist/seats/cliAdapter.js";
import { buildXeniaUserMessage, invokeXeniaSeat, parseXeniaContent } from "../../dist/seats/xeniaAdapter.js";

const seat = (over: Partial<SeatConfig> = {}): SeatConfig => ({
  id: "gemini", label: "Gemini", adapter: "xenia", xeniaModel: "cc/claude-haiku-4-5-20251001",
  role: "ARCHITECTURE", temperature: 0.2, maxTokens: 4096, timeoutMs: 1_000, enabled: true, tier: "standard",
  ...over,
});

const VERDICT = { seat: "whatever", findings: [], overall_verdict: "APPROVE", verdict_reasoning: "ok", raw_usage: { promptTokens: 1, completionTokens: 2 } };

const respond = (body: unknown, init: ResponseInit = {}) =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })) as unknown as typeof fetch;

const invoke = (fetchImpl: typeof fetch, over: Partial<SeatConfig> = {}) =>
  invokeXeniaSeat({ seat: seat(over), prompt: "review this", baseUrl: "http://xenia.test", fetchImpl });

type Captured = { url: string; headers: Headers; body: any };
const capturing = (sink: Captured[], reply: () => Response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VERDICT) } }] }), { status: 200 })) =>
  (async (url: string, init: RequestInit) => {
    sink.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return reply();
  }) as unknown as typeof fetch;

const KEY_ENV = "CONCLAVE_XENIA_API_KEY";
async function withApiKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[KEY_ENV];
  if (value === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = previous;
  }
}

/** Shape observed live from OmniRoute on 2026-09-27 (claude-haiku-4-5 via auto/cheap): fenced content, cost in a header. */
const LIVE_HAIKU_RESPONSE = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-msg_x", object: "chat.completion", model: "claude-haiku-4-5-20251001",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "```json\n" + JSON.stringify(VERDICT, null, 2) + "\n```" } }],
      usage: { prompt_tokens: 763, completion_tokens: 92, total_tokens: 855 },
    }),
    { status: 200, headers: { "content-type": "application/json", "x-xenia-model": "claude-haiku-4-5-20251001", "x-xenia-tokens-in": "763", "x-xenia-tokens-out": "92", "x-xenia-response-cost": "0.0012230000" } },
  );

test("parses the live-observed gateway response (fenced content, cost header) into a verdict and authoritative usage", async () => {
  const { verdict, usage, commandRuns } = await invoke((async () => LIVE_HAIKU_RESPONSE()) as unknown as typeof fetch);
  assert.equal(verdict.overall_verdict, "APPROVE");
  assert.equal(verdict.seat, "gemini", "the seat id comes from configuration, not from the model");
  assert.equal(usage?.promptTokens, 763);
  assert.equal(usage?.completionTokens, 92);
  assert.equal(usage?.costUsd, 0.001223);
  assert.equal(usage?.cachedInputTokens, undefined);
  assert.equal(usage?.source, "xenia_envelope");
  assert.deepEqual(commandRuns, [], "a xenia seat has no shell, so it never runs commands");
});

test("gateway token headers win over the body, because the cost header is computed from them", async () => {
  const { usage } = await invoke(
    respond(
      { choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: 65, completion_tokens: 128, prompt_tokens_details: { cache_creation_tokens: 885 } } },
      { headers: { "x-xenia-tokens-in": "950", "x-xenia-tokens-out": "128", "x-xenia-response-cost": "0.0181125" } },
    ),
  );
  assert.equal(usage?.promptTokens, 950);
  assert.equal(usage?.completionTokens, 128);
  assert.equal(usage?.costUsd, 0.0181125);
});

test("without token headers, body prompt_tokens has cache-creation tokens added back (observed: they are excluded)", async () => {
  const { usage } = await invoke(
    respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: 65, completion_tokens: 128, total_tokens: 193, prompt_tokens_details: { cache_creation_tokens: 885 }, completion_tokens_details: { reasoning_tokens: 25 } } }),
  );
  assert.equal(usage?.promptTokens, 950);
  assert.equal(usage?.completionTokens, 128);
  assert.equal(usage?.costUsd, undefined, "no cost header means no authoritative cost; the caller estimates");
});

test("OpenAI-standard cached_tokens is reported as a subset of prompt tokens", async () => {
  const { usage } = await invoke(
    respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: 120, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 80 } } }),
  );
  assert.equal(usage?.promptTokens, 120);
  assert.equal(usage?.cachedInputTokens, 80);
});

test("a cost field in the body is not trusted; only the gateway's cost header is", async () => {
  const { usage } = await invoke(
    respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost_usd: 5 } }),
  );
  assert.equal(usage?.costUsd, undefined);
});

test("usage is reported as unavailable rather than zero when the gateway omits it", async () => {
  const { usage } = await invoke(respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }] }));
  assert.equal(usage, null);
});

test("implausible usage values are rejected rather than trusted", async () => {
  const { usage } = await invoke(
    respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: -5, completion_tokens: 40 } }),
  );
  assert.equal(usage, null);
  const { usage: fromHeaders } = await invoke(
    respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }] }, { headers: { "x-xenia-tokens-in": "-3", "x-xenia-tokens-out": "abc" } }),
  );
  assert.equal(fromHeaders, null);
});

test("a negative or garbage cost header is dropped while token counts are kept", async () => {
  for (const cost of ["-1", "NaN", "1e9", ""]) {
    const { usage } = await invoke(
      respond({ choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }, { headers: { "x-xenia-response-cost": cost } }),
    );
    assert.equal(usage?.costUsd, undefined, `cost header ${JSON.stringify(cost)}`);
    assert.equal(usage?.promptTokens, 10);
  }
});

test("sends the model, the strict schema, and both messages; no Authorization header without a key", async () => {
  const calls: Captured[] = [];
  await withApiKey(undefined, () => invoke(capturing(calls)));
  const [call] = calls;
  assert.equal(call.url, "http://xenia.test/v1/chat/completions");
  assert.equal(call.body.model, "cc/claude-haiku-4-5-20251001");
  assert.equal(call.body.response_format.type, "json_schema");
  assert.equal(call.body.response_format.json_schema.strict, true);
  assert.equal(call.body.response_format.json_schema.schema.type, "object");
  assert.deepEqual(call.body.messages.map((m: any) => m.role), ["system", "user"]);
  assert.match(call.body.messages[0].content, /no shell, filesystem, or network access/);
  assert.equal(call.body.messages[1].content, "review this");
  assert.equal(call.headers.get("authorization"), null);
  assert.equal(call.headers.get("content-type"), "application/json");
});

test("a trailing slash on the base URL does not produce a double slash", async () => {
  const calls: Captured[] = [];
  await invokeXeniaSeat({ seat: seat(), prompt: "p", baseUrl: "http://xenia.test///", fetchImpl: capturing(calls) });
  assert.equal(calls[0].url, "http://xenia.test/v1/chat/completions");
});

test("CONCLAVE_XENIA_API_KEY is sent as a bearer token and never echoed in errors", async () => {
  const secret = "sk-test-do-not-echo-123";
  const calls: Captured[] = [];
  await withApiKey(`  ${secret}  `, () => invoke(capturing(calls)));
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${secret}`);

  const failing = (async () => new Response(JSON.stringify({ error: { message: "invalid api key", code: "unauthorized" } }), { status: 401 })) as unknown as typeof fetch;
  const error = await withApiKey(secret, () => invoke(failing).then(() => undefined, (e: unknown) => e));
  assert.match(String(error), /xenia responded 401: unauthorized: invalid api key/);
  assert.doesNotMatch(String(error), new RegExp(secret));

  const blank = await withApiKey("   ", async () => { const sink: Captured[] = []; await invoke(capturing(sink)); return sink[0]; });
  assert.equal(blank.headers.get("authorization"), null, "a blank key is treated as unset");
});

test("repoContext is appended under a heading that says it is the seat's only view of the repo", async () => {
  const calls: Captured[] = [];
  await invokeXeniaSeat({ seat: seat(), prompt: "review this", repoContext: "### src/a.ts\nexport const a = 1;", baseUrl: "http://xenia.test", fetchImpl: capturing(calls) });
  const user: string = calls[0].body.messages[1].content;
  assert.ok(user.startsWith("review this\n\n## Repository context"), user);
  assert.match(user, /cannot read files or run commands/);
  assert.match(user, /ONLY view of the repository/);
  assert.match(user, /do not claim to have inspected/);
  assert.ok(user.endsWith("### src/a.ts\nexport const a = 1;"));
});

test("an absent or blank repoContext leaves the prompt untouched", () => {
  assert.equal(buildXeniaUserMessage("p"), "p");
  assert.equal(buildXeniaUserMessage("p", ""), "p");
  assert.equal(buildXeniaUserMessage("p", "  \n "), "p");
});

test("content extraction tolerates fences, think blocks, prose, and array-of-parts content", () => {
  assert.deepEqual(parseXeniaContent('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseXeniaContent('```\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseXeniaContent('  {"a":3}  '), { a: 3 });
  assert.deepEqual(parseXeniaContent('Here is my verdict:\n```json\n{"a":4}\n```\nThanks.'), { a: 4 });
  assert.deepEqual(parseXeniaContent('<think>the {braces} here are not JSON</think>\n{"a":5}'), { a: 5 });
  assert.deepEqual(parseXeniaContent('<thinking>x</thinking><think>y</think>```json\n{"a":6}\n```'), { a: 6 });
  assert.deepEqual(parseXeniaContent('Verdict follows. {"a":7} End.'), { a: 7 });
  assert.deepEqual(
    parseXeniaContent([{ type: "reasoning", text: "{not json" }, { type: "text", text: '{"a":' }, { type: "text", text: "8}" }]),
    { a: 8 },
    "reasoning parts are dropped and text parts are joined",
  );
  assert.deepEqual(parseXeniaContent(['{"a":9}']), { a: 9 });
  assert.throws(() => parseXeniaContent(undefined), /not a string/);
  assert.throws(() => parseXeniaContent(null), /not a string/);
  assert.throws(() => parseXeniaContent([{ type: "image_url" }]), /not a string/);
  assert.throws(() => parseXeniaContent("no json at all"));
});

test("array-of-parts content parses end to end into a verdict", async () => {
  const { verdict } = await invoke(respond({ choices: [{ message: { content: [{ type: "text", text: JSON.stringify(VERDICT) }] } }] }));
  assert.equal(verdict.overall_verdict, "APPROVE");
});

test("a non-2xx response surfaces the status and body", async () => {
  const failing = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => invoke(failing), /xenia responded 404: model not found/);
});

test("a non-2xx OpenAI error envelope is condensed to code and message, and is not a malformed verdict", async () => {
  // Exact body the live gateway returns for an unknown model id.
  const failing = respond({ error: { message: "No active credentials for provider: no.", type: "invalid_request_error", code: "model_not_found" } }, { status: 404 });
  await assert.rejects(() => invoke(failing), (error: Error) => {
    assert.match(error.message, /xenia responded 404: model_not_found: No active credentials for provider: no\./);
    assert.doesNotMatch(error.message, /invalid verdict/);
    return true;
  });
});

test("a 200 carrying an error envelope instead of choices is a provider failure, not a malformed verdict", async () => {
  await assert.rejects(() => invoke(respond({ error: { message: "upstream exploded" } })), (error: Error) => {
    assert.match(error.message, /xenia returned no choices: upstream exploded/);
    assert.doesNotMatch(error.message, /invalid verdict/);
    return true;
  });
});

test("a malformed verdict is rejected rather than half-parsed", async () => {
  await assert.rejects(
    () => invoke(respond({ choices: [{ message: { content: '{"overall_verdict":"MAYBE"}' } }] })),
    /invalid verdict/,
  );
});

test("a truncated reply says so, and is still classified as a malformed verdict", async () => {
  await assert.rejects(
    () => invoke(respond({ choices: [{ finish_reason: "length", message: { content: '{"seat":"x","findings":[' } }] })),
    /invalid verdict \(finish_reason=length; maxTokens 4096 too low\?\)/,
  );
});

test("a non-JSON body is reported as such", async () => {
  const garbage = (async () => new Response("<html>gateway down</html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => invoke(garbage), /non-JSON body/);
});

test("a seat without a model, or on the wrong adapter, is refused before any request", async () => {
  const unreachable = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
  await assert.rejects(() => invoke(unreachable, { xeniaModel: undefined }), /xeniaModel is required/);
  await assert.rejects(() => invoke(unreachable, { adapter: "cli" }), /not a xenia adapter/);
});

test("an already-aborted signal is refused before any request", async () => {
  const unreachable = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
  await assert.rejects(
    () => invokeXeniaSeat({ seat: seat(), prompt: "p", baseUrl: "http://xenia.test", fetchImpl: unreachable, signal: AbortSignal.abort() }),
    /cancelled before invocation/,
  );
});

const hanging = ((_url: string, init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as unknown as typeof fetch;

test("caller cancellation is reported as cancellation, not as a timeout", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    () => invokeXeniaSeat({ seat: seat({ timeoutMs: 5_000 }), prompt: "p", baseUrl: "http://xenia.test", fetchImpl: hanging, signal: controller.signal }),
    (error: Error) => error instanceof CliCancelledError && /cancelled/.test(error.message),
  );
});

test("the seat's own timeout fires when the caller never cancels", async () => {
  await assert.rejects(
    () => invokeXeniaSeat({ seat: seat({ timeoutMs: 30 }), prompt: "p", baseUrl: "http://xenia.test", fetchImpl: hanging }),
    (error: Error) => !(error instanceof CliCancelledError) && /timed out after 30ms/.test(error.message),
  );
});

test("the timeout also covers a body that stalls after the headers arrive", async () => {
  const stalling = (async (_url: string, init: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":'));
        init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => invokeXeniaSeat({ seat: seat({ timeoutMs: 30 }), prompt: "p", baseUrl: "http://xenia.test", fetchImpl: stalling }),
    /timed out after 30ms/,
  );
});
