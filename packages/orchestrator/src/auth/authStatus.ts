import { spawn } from "node:child_process";
import type { SeatConfig } from "@conclave/core";
import { cliKind, commandFor, killProcessTree, seatCliOptions, timerMs } from "../seats/cliAdapter.js";
import { xeniaAuthHeaders, xeniaBaseUrl } from "../seats/xeniaAdapter.js";

/**
 * `binaryFound` keeps its name for existing callers' MISSING/FAIL labels. For a xenia seat it means
 * "gateway reachable", and for a fake seat it is always true.
 */
export interface SeatAuthStatus {
  seat: string;
  adapter?: SeatConfig["adapter"];
  cliCommand: string;
  binaryFound: boolean;
  healthy: boolean;
  detail: string;
  loginHint: string;
  /** True when this seat was deliberately not probed (a CLI probe is a billed model call). */
  unchecked?: boolean;
}
const LOGIN_HINTS: Record<string, string> = { claude: "claude /login", codex: "codex login", antigravity: "open the Antigravity app to sign in (no `agy login` subcommand exists)" };
const PROBE_PROMPT = "Reply exactly OK";
/**
 * The login probe for a CLI seat. It carries the seat's configured model and extra flags, so a seat
 * that only works with its configured model (or provider override) is judged the way a run uses it.
 * A seat driven by an argument template is probed through that template, exactly as a run invokes it.
 */
export function healthProbeArgs(seat: SeatConfig): string[] {
  if (seat.cliArgsTemplate?.length && seat.cliCommand) return commandFor(seat, PROBE_PROMPT, "audit").args;
  const options = seatCliOptions(seat);
  const kind = cliKind(seat);
  if (kind === "claude") return ["-p", PROBE_PROMPT, "--output-format", "text", "--tools", "", ...options];
  // The probe runs wherever doctor or the web server was started, which need not be a git repository.
  if (kind === "codex") return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", ...options, PROBE_PROMPT];
  return ["-p", PROBE_PROMPT, "--output-format", "text", "--sandbox", "--disable-slash-commands", ...options];
}
async function checkCliSeatHealth(seat: SeatConfig, cwd: string, timeoutMs: number): Promise<SeatAuthStatus> {
  const command = seat.cliCommand ?? seat.id;
  return await new Promise((resolve) => {
    // Detached, like a seat run, so a timeout can kill the CLI's whole process tree: a wrapper's
    // child left running would keep making the (billed) call and keep this process alive.
    const child = spawn(command, healthProbeArgs(seat), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: process.platform !== "win32" });
    let output = ""; let settled = false;
    const finish = (status: Omit<SeatAuthStatus, "seat" | "adapter" | "cliCommand" | "loginHint">) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const kind = cliKind(seat);
      resolve({ seat: seat.id, adapter: "cli", cliCommand: command, loginHint: kind === "other" ? `${command} login` : LOGIN_HINTS[kind]!, ...status });
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => output += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => output += chunk);
    child.on("error", (error: NodeJS.ErrnoException) => finish({ binaryFound: error.code !== "ENOENT", healthy: false, detail: error.message }));
    child.on("close", (code) => {
      const healthy = code === 0 && /\bOK\b/i.test(output);
      // A healthy CLI's raw output is noise (hook logs, token counts); only a failure's output helps.
      finish({ binaryFound: true, healthy, detail: healthy ? "responded" : code === 0 ? output.trim().slice(-240) : `exit ${code}: ${output.trim().slice(-200)}` });
    });
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
      setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000).unref();
      finish({ binaryFound: true, healthy: false, detail: `health check timed out after ${timeoutMs}ms` });
    }, timerMs(timeoutMs));
  });
}

/** A xenia health check only lists models, so it never spends tokens; keep it short. */
const XENIA_HEALTH_TIMEOUT_MS = 5_000;

const modelTokens = (id: string) => new Set(id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
/** Tier/variant words and bare numbers that say nothing about the model family on their own. */
const GENERIC_MODEL_TOKENS = new Set(["max", "pro", "high", "low", "medium", "xhigh", "ultra", "mini", "nano", "fast", "free", "latest", "preview", "large", "small", "flash", "lite", "thinking"]);
const isDistinctive = (token: string) => !GENERIC_MODEL_TOKENS.has(token) && !/^\d+$/.test(token);

/**
 * Up to `limit` listed ids closest to `wanted`: token-set Jaccard similarity (so "3.1" matches
 * "3-1"), plus a bonus when a candidate contains the wanted id's name after its provider prefix.
 * A candidate must share at least one distinctive token (a family name, not just "max" or "5").
 */
export function suggestXeniaModels(wanted: string, available: string[], limit = 3): string[] {
  const want = modelTokens(wanted);
  const tail = wanted.toLowerCase().split("/").slice(1).join("/") || wanted.toLowerCase();
  return available
    .map((id) => {
      const have = modelTokens(id);
      const sharedTokens = [...want].filter((token) => have.has(token));
      const union = new Set([...want, ...have]).size;
      const score = (union ? sharedTokens.length / union : 0) + (id.toLowerCase().includes(tail) ? 0.5 : 0);
      return { id, distinctive: sharedTokens.some(isDistinctive), score };
    })
    .filter((candidate) => candidate.distinctive)
    .sort((a, b) => b.score - a.score || a.id.length - b.id.length || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

const describeFetchError = (error: unknown): string => {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  if (cause && typeof cause.message === "string") return cause.message;
  return error instanceof Error ? error.message : String(error);
};

export interface XeniaHealthOptions {
  /** Overrides CONCLAVE_XENIA_BASE_URL, resolved exactly as the adapter resolves it. */
  xeniaBaseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

async function checkXeniaSeatHealth(seat: SeatConfig, timeoutMs: number, options: XeniaHealthOptions): Promise<SeatAuthStatus> {
  const base = xeniaBaseUrl(options.xeniaBaseUrl);
  const model = seat.xeniaModel;
  const status = (fields: Pick<SeatAuthStatus, "binaryFound" | "healthy" | "detail">): SeatAuthStatus => ({
    seat: seat.id,
    adapter: "xenia",
    cliCommand: `xenia:${model ?? "(no model)"}`,
    loginHint: `set xeniaModel to a model listed by ${base}/v1/models, or check CONCLAVE_XENIA_BASE_URL / CONCLAVE_XENIA_API_KEY`,
    ...fields,
  });
  const budget = Math.min(timeoutMs, XENIA_HEALTH_TIMEOUT_MS);
  let response: Response;
  let raw: string;
  try {
    response = await (options.fetchImpl ?? fetch)(`${base}/v1/models`, {
      headers: { accept: "application/json", ...xeniaAuthHeaders() },
      signal: AbortSignal.timeout(budget),
    });
    raw = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return status({
      binaryFound: false,
      healthy: false,
      detail: timedOut ? `gateway at ${base} did not answer within ${budget}ms` : `gateway not reachable at ${base}: ${describeFetchError(error)}`,
    });
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? " (check CONCLAVE_XENIA_API_KEY)" : "";
    return status({ binaryFound: true, healthy: false, detail: `gateway answered ${response.status} for /v1/models${hint}: ${raw.slice(0, 200).trim()}` });
  }
  let ids: string[];
  try {
    const data = (JSON.parse(raw) as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error("no data array");
    ids = data.flatMap((entry) => (typeof (entry as { id?: unknown })?.id === "string" ? [(entry as { id: string }).id] : []));
  } catch {
    return status({ binaryFound: true, healthy: false, detail: `gateway at ${base} returned an unrecognised /v1/models body` });
  }
  if (!model) return status({ binaryFound: true, healthy: false, detail: `seat has no xeniaModel configured (${ids.length} models listed)` });
  if (ids.includes(model)) {
    return status({ binaryFound: true, healthy: true, detail: `model listed by ${base}/v1/models (listing only; no tokens spent)` });
  }
  const suggestions = suggestXeniaModels(model, ids);
  return status({
    binaryFound: true,
    healthy: false,
    detail: `model "${model}" is not listed by ${base}/v1/models (${ids.length} models)` + (suggestions.length ? `; closest: ${suggestions.join(", ")}` : ""),
  });
}

/**
 * Dispatches on the seat's adapter. A cli seat is probed by actually running its CLI. A xenia seat
 * only has its model looked up in the gateway's listing, so this never spends tokens. A fake seat
 * is always healthy. `options` is only consulted for xenia seats.
 */
export async function checkSeatHealth(seat: SeatConfig, cwd: string, timeoutMs = 30_000, options: XeniaHealthOptions = {}): Promise<SeatAuthStatus> {
  switch (seat.adapter) {
    case "cli":
      return await checkCliSeatHealth(seat, cwd, timeoutMs);
    case "xenia":
      return await checkXeniaSeatHealth(seat, timeoutMs, options);
    case "fake":
      return { seat: seat.id, adapter: "fake", cliCommand: "fake", binaryFound: true, healthy: true, detail: "in-process fake seat (no provider)", loginHint: "none needed" };
    default: {
      const adapter: never = seat.adapter;
      return { seat: (seat as SeatConfig).id, cliCommand: String(adapter), binaryFound: false, healthy: false, detail: `unsupported seat adapter: ${String(adapter)}`, loginHint: "set adapter to cli, xenia, or fake" };
    }
  }
}
export async function checkAllSeatHealth(seats: SeatConfig[], cwd: string) { return await Promise.all(seats.map((seat) => checkSeatHealth(seat, cwd))); }

export interface ModelProbeResult extends SeatAuthStatus {
  /** The model tried; undefined means the seat's CLI default. */
  model?: string;
  /** The model the provider reports having answered with, when it says. */
  answeredBy?: string;
}

/**
 * Tries a model for real before a seat is switched to it: one tiny call, exactly as a run would make
 * it (a CLI seat with its model and extra flags; a gateway seat with a real completion, not just a
 * listing lookup — a listed model can still fail upstream). This spends a little; callers must only
 * run it on an explicit request.
 */
export async function probeSeatModel(
  seat: SeatConfig,
  model: string | undefined,
  cwd: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelProbeResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (seat.adapter === "cli") {
    const candidate = { ...seat, cliModel: model?.trim() || undefined };
    return { ...(await checkCliSeatHealth(candidate, cwd, timeoutMs)), model: candidate.cliModel };
  }
  if (seat.adapter === "fake") {
    return { ...(await checkSeatHealth(seat, cwd)), model };
  }
  const target = model?.trim() || seat.xeniaModel;
  const base = { seat: seat.id, adapter: "xenia" as const, cliCommand: `xenia:${target ?? "?"}`, loginHint: "pick a model the gateway lists, or check CONCLAVE_XENIA_BASE_URL / CONCLAVE_XENIA_API_KEY", model: target };
  if (!target) return { ...base, binaryFound: true, healthy: false, detail: "no model given" };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${xeniaBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...xeniaAuthHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: target, max_tokens: 8, messages: [{ role: "user", content: "Reply exactly OK" }] }),
    });
    const text = await response.text();
    if (!response.ok) return { ...base, binaryFound: true, healthy: false, detail: `gateway responded ${response.status}: ${text.slice(0, 200).trim()}` };
    let body: { model?: string; choices?: Array<{ message?: { content?: unknown } }> };
    try {
      body = JSON.parse(text);
    } catch {
      return { ...base, binaryFound: true, healthy: false, detail: `gateway answered ${response.status} with a non-JSON body: ${text.slice(0, 120).trim()}` };
    }
    const content = body.choices?.[0]?.message?.content;
    const healthy = typeof content === "string" && /\bOK\b/i.test(content);
    return { ...base, binaryFound: true, healthy, detail: healthy ? "responded" : `unexpected reply: ${String(content).slice(0, 120)}`, answeredBy: body.model };
  } catch (error) {
    return { ...base, binaryFound: false, healthy: false, detail: `gateway unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
