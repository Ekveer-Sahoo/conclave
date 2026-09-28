import { VerdictSchema, type SeatConfig, type Verdict } from "@conclave/core";
import {
  CliCancelledError,
  CliInvocationError,
  VERDICT_JSON_SCHEMA,
  type CommandCapture,
  type ProviderUsage,
} from "./cliAdapter.js";

/**
 * Xenia is a local multi-provider gateway exposing an OpenAI-compatible chat-completions endpoint;
 * a seat's `xeniaModel` selects which upstream model it routes to.
 *
 * ---------------------------------------------------------------------------------------------
 * VERIFIED on 2026-09-27 against a live OmniRoute gateway (x-xenia-version 3.8.50) at
 * http://localhost:20128. End-to-end requests parsed into valid Verdicts via `auto/cheap` (routed to
 * claude-haiku-4-5 and, on another call, claude-fable-5), `auto/best-fast` (routed to
 * claude-sonnet-5), and `cc/claude-haiku-4-5-20251001` pinned directly. What that run confirmed:
 *
 * - Auth: neither `/v1/models` nor `/v1/chat/completions` needs an Authorization header on this
 *   instance, and a bogus bearer token is ignored. `Authorization: Bearer $CONCLAVE_XENIA_API_KEY`
 *   is still sent when the variable is set, for gateways that do enforce keys.
 * - `response_format: {type:"json_schema", strict:true}` is ACCEPTED (never a 400) but NOT always
 *   honored: the Claude-routed upstream returned the verdict wrapped in a ```json fence. Content
 *   extraction therefore tolerates fences (and, defensively, `<think>` prefixes and array-of-parts
 *   content, though neither was observed). No json_object fallback exists because none was needed.
 * - `message.content` was always a string.
 * - Usage: body `usage` is `{prompt_tokens, completion_tokens, total_tokens}`, sometimes with
 *   `prompt_tokens_details.cache_creation_tokens` and `completion_tokens_details.reasoning_tokens`.
 *   Body `prompt_tokens` EXCLUDES cache-creation tokens (observed 65 + 885 = 950). The gateway's own
 *   totals arrive as headers `x-xenia-tokens-in` / `x-xenia-tokens-out` (950 / 128 in that case).
 *   There is no cost field in the body. Cost arrives only as the `x-xenia-response-cost` header, in
 *   USD, and matched upstream list price exactly (763 in / 92 out on haiku-4-5 = 0.001223).
 * - `auto/*` combos route non-deterministically. The same `auto/cheap` request cost $0.0012 on
 *   haiku and $0.018 on fable-5, so seats should pin explicit model ids.
 * - A listed model is not necessarily usable. On that date, oc/*, dva/*, aug/*, cx/*, ddgw/* and
 *   tllm/* all failed inside the gateway or upstream (4xx/5xx), and only cc/* (Claude) answered.
 *   An unknown id returns 404 `model_not_found` without reaching any upstream.
 * ---------------------------------------------------------------------------------------------
 *
 * Contract as used:
 *   POST {baseUrl}/v1/chat/completions   [Authorization: Bearer <key> when configured]
 *   { model, messages:[{role,content}], temperature, max_tokens,
 *     response_format:{ type:"json_schema", json_schema:{ name, strict, schema } } }
 *   → { choices:[{ message:{ content }, finish_reason }], usage:{ prompt_tokens, completion_tokens, … } }
 *     + headers x-xenia-tokens-in, x-xenia-tokens-out, x-xenia-response-cost
 */
export const DEFAULT_XENIA_BASE_URL = "http://localhost:20128";

/** Environment variable holding the gateway API key. Its value is never logged or echoed. */
export const XENIA_API_KEY_ENV = "CONCLAVE_XENIA_API_KEY";

export const xeniaBaseUrl = (override?: string): string =>
  (override ?? process.env.CONCLAVE_XENIA_BASE_URL ?? DEFAULT_XENIA_BASE_URL).replace(/\/+$/, "");

/** Auth header for the gateway, or none when no key is configured (the local gateway needs none). */
export function xeniaAuthHeaders(): Record<string, string> {
  const key = process.env[XENIA_API_KEY_ENV]?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

export interface XeniaInvocation {
  seat: SeatConfig;
  prompt: string;
  /**
   * Repository excerpt assembled by the orchestrator. A xenia seat has no shell or filesystem, so
   * this is its only view of the code under review.
   */
  repoContext?: string;
  /** Overrides CONCLAVE_XENIA_BASE_URL, which in turn overrides the localhost default. */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  "You are one seat on a code review council. Judge only your assigned concern. " +
  "You have no shell, filesystem, or network access: judge only from the text you are given, and never " +
  "claim to have opened, run, or inspected anything beyond it. " +
  "Respond with a single JSON object matching the provided schema — no prose, no code fences.";

const REPO_CONTEXT_HEADING = "## Repository context (supplied by the orchestrator)";

/** Appends the repo excerpt under a heading that tells the model it is the only view it gets. */
export function buildXeniaUserMessage(prompt: string, repoContext?: string): string {
  if (!repoContext?.trim()) return prompt;
  return (
    `${prompt}\n\n${REPO_CONTEXT_HEADING}\n` +
    "You cannot read files or run commands. The excerpt below is your ONLY view of the repository. " +
    "Base findings on it alone, do not claim to have inspected anything it does not contain, and say " +
    "so in verdict_reasoning when a concern cannot be judged from it.\n\n" +
    repoContext
  );
}

const MAX_PLAUSIBLE_TOKENS = 5_000_000;
const MAX_PLAUSIBLE_COST_USD = 100;

const tokenCount = (value: unknown): number | undefined => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_PLAUSIBLE_TOKENS ? n : undefined;
};

const costUsd = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_PLAUSIBLE_COST_USD ? n : undefined;
};

/**
 * Usage comes from the gateway, never from the model's self-reported `raw_usage` inside the
 * verdict, which a model can fabricate freely.
 *
 * Token totals prefer the gateway's own `x-xenia-tokens-in` / `-out` headers, the same figures its
 * cost header is computed from. Without them we fall back to the body, where `prompt_tokens`
 * excludes cache-creation tokens, so those are added back. `cachedInputTokens` is taken from the
 * OpenAI-standard `prompt_tokens_details.cached_tokens` (a SUBSET of promptTokens; not yet observed
 * nonzero). Cost is only ever the `x-xenia-response-cost` header; when it is absent, the caller
 * falls back to a local estimate.
 */
export function extractXeniaUsage(body: unknown, headers?: Headers): ProviderUsage | null {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
  const record = usage && typeof usage === "object" ? usage : undefined;
  const details = record?.prompt_tokens_details as Record<string, unknown> | undefined;

  let promptTokens = tokenCount(headers?.get("x-xenia-tokens-in"));
  let completionTokens = tokenCount(headers?.get("x-xenia-tokens-out"));
  if (promptTokens === undefined || completionTokens === undefined) {
    const bodyPrompt = tokenCount(record?.prompt_tokens);
    const bodyCompletion = tokenCount(record?.completion_tokens);
    if (bodyPrompt === undefined || bodyCompletion === undefined) return null;
    promptTokens = bodyPrompt + (tokenCount(details?.cache_creation_tokens) ?? 0);
    completionTokens = bodyCompletion;
  }
  const cached = tokenCount(details?.cached_tokens);
  return {
    promptTokens,
    completionTokens,
    cachedInputTokens: cached !== undefined && cached <= promptTokens ? cached : undefined,
    costUsd: costUsd(headers?.get("x-xenia-response-cost") ?? null),
    source: "xenia_envelope",
  };
}

/** Flattens OpenAI message content: a plain string, or an array of text parts (reasoning parts dropped). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.flatMap((part) => {
      if (typeof part === "string") return [part];
      const p = part as { type?: unknown; text?: unknown } | null;
      if (p && typeof p.text === "string" && (p.type === undefined || p.type === "text" || p.type === "output_text")) {
        return [p.text];
      }
      return [];
    });
    if (texts.length > 0) return texts.join("");
  }
  throw new Error("response message content was not a string or an array of text parts");
}

/**
 * Pulls the verdict JSON out of whatever the upstream produced. Observed live: a ```json fence
 * despite the strict schema request. Tolerated defensively: leading `<think>`/`<thinking>` blocks,
 * array-of-parts content, and prose around a single top-level object.
 */
export function parseXeniaContent(content: unknown): unknown {
  const text = messageText(content)
    .replace(/^\s*(?:<(think|thinking)>[\s\S]*?<\/\1>\s*)+/i, "")
    .trim();
  const attempts = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) attempts.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no JSON object found in response content");
}

/** Pulls a concise message out of an OpenAI-style `{error:{message,code}}` body, else raw text. */
function gatewayErrorDetail(raw: string): string {
  try {
    const error = (JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } | string }).error;
    if (typeof error === "string") return error;
    if (error && typeof error.message === "string") {
      return typeof error.code === "string" && error.code ? `${error.code}: ${error.message}` : error.message;
    }
  } catch {
    // not JSON; fall through to the raw text
  }
  return raw;
}

export async function invokeXeniaSeat(input: XeniaInvocation): Promise<{
  verdict: Verdict;
  usage: ProviderUsage | null;
  commandRuns: CommandCapture[];
}> {
  const { seat } = input;
  if (seat.adapter !== "xenia") throw new CliInvocationError(seat.id, "seat is not a xenia adapter");
  if (!seat.xeniaModel) throw new CliInvocationError(seat.id, "xeniaModel is required");
  if (input.signal?.aborted) throw new CliCancelledError(seat.id, "cancelled before invocation");

  const doFetch = input.fetchImpl ?? fetch;
  const url = `${xeniaBaseUrl(input.baseUrl)}/v1/chat/completions`;

  // The gateway gets both the caller's abort signal and this seat's own timeout; whichever fires
  // first wins, and we distinguish them afterwards so a timeout is not reported as a cancellation.
  // The timer covers reading the body too, not just receiving headers.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), seat.timeoutMs);
  const signals = [timeoutController.signal, input.signal].filter(Boolean) as AbortSignal[];
  const combined = AbortSignal.any(signals);

  let response: Response;
  let raw: string;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...xeniaAuthHeaders() },
      signal: combined,
      body: JSON.stringify({
        model: seat.xeniaModel,
        temperature: seat.temperature,
        max_tokens: seat.maxTokens,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildXeniaUserMessage(input.prompt, input.repoContext) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "conclave_verdict", strict: true, schema: VERDICT_JSON_SCHEMA },
        },
      }),
    });
    raw = await response.text();
  } catch (error) {
    if (input.signal?.aborted) throw new CliCancelledError(seat.id, "cancelled");
    if (timeoutController.signal.aborted) {
      throw new CliInvocationError(seat.id, `timed out after ${seat.timeoutMs}ms`);
    }
    throw new CliInvocationError(seat.id, `xenia request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new CliInvocationError(
      seat.id,
      `xenia responded ${response.status}: ${gatewayErrorDetail(raw).slice(0, 500).trim()}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw new CliInvocationError(seat.id, `xenia returned non-JSON body: ${String(error)}`);
  }

  // A 200 carrying an error envelope instead of choices is a provider failure (UNAVAILABLE), not a
  // malformed verdict, so it must not produce an "invalid verdict" message.
  const choice = (body as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })
    ?.choices?.[0];
  if (!choice) {
    const detail = gatewayErrorDetail(raw);
    throw new CliInvocationError(seat.id, `xenia returned no choices: ${detail.slice(0, 500).trim()}`);
  }

  try {
    const verdict = VerdictSchema.parse(parseXeniaContent(choice.message?.content));
    return {
      verdict: { ...verdict, seat: seat.id },
      usage: extractXeniaUsage(body, response.headers),
      // Xenia seats reason over the prompt alone; they have no shell, so they never run commands.
      commandRuns: [],
    };
  } catch (error) {
    const truncated = choice.finish_reason === "length" ? ` (finish_reason=length; maxTokens ${seat.maxTokens} too low?)` : "";
    throw new CliInvocationError(seat.id, `invalid verdict${truncated}: ${String(error)}`);
  }
}
