import { spawn } from "node:child_process";
import type { SeatConfig } from "@conclave/core";
import { seatCliOptions } from "../seats/cliAdapter.js";
import { xeniaAuthHeaders, xeniaBaseUrl } from "../seats/xeniaAdapter.js";

/**
 * `binaryFound` keeps its name for existing callers' MISSING/FAIL labels. For a xenia seat it means
 * "gateway reachable", and for a fake seat it is always true.
 */
export interface SeatAuthStatus { seat: string; adapter?: SeatConfig["adapter"]; cliCommand: string; binaryFound: boolean; healthy: boolean; detail: string; loginHint: string }
const LOGIN_HINTS: Record<string, string> = { claude: "claude /login", codex: "codex login", antigravity: "open the Antigravity app to sign in (no `agy login` subcommand exists)" };
/**
 * The login probe for a CLI seat. It carries the seat's configured model and extra flags, so a seat
 * that only works with its configured model (or provider override) is judged the way a run uses it.
 */
export function healthProbeArgs(seat: SeatConfig): string[] {
  const options = seatCliOptions(seat);
  if (seat.id === "claude") return ["-p", "Reply exactly OK", "--output-format", "text", "--tools", "", ...options];
  if (seat.id === "codex") return ["exec", "--sandbox", "read-only", "--color", "never", ...options, "Reply exactly OK"];
  return ["-p", "Reply exactly OK", "--output-format", "text", "--sandbox", "--disable-slash-commands", ...options];
}
async function checkCliSeatHealth(seat: SeatConfig, cwd: string, timeoutMs: number): Promise<SeatAuthStatus> {
  const command = seat.cliCommand ?? seat.id;
  return await new Promise((resolve) => {
    const child = spawn(command, healthProbeArgs(seat), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = ""; let settled = false;
    const finish = (status: Omit<SeatAuthStatus, "seat" | "adapter" | "cliCommand" | "loginHint">) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ seat: seat.id, adapter: "cli", cliCommand: command, loginHint: LOGIN_HINTS[seat.id] ?? `${command} login`, ...status });
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => output += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => output += chunk);
    child.on("error", (error: NodeJS.ErrnoException) => finish({ binaryFound: error.code !== "ENOENT", healthy: false, detail: error.message }));
    child.on("close", (code) => {
      const healthy = code === 0 && /\bOK\b/i.test(output);
      // A healthy CLI's raw output is noise (hook logs, token counts); only a failure's output helps.
      finish({ binaryFound: true, healthy, detail: healthy ? "responded" : code === 0 ? output.trim().slice(-240) : `exit ${code}: ${output.trim().slice(-200)}` });
    });
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish({ binaryFound: true, healthy: false, detail: `health check timed out after ${timeoutMs}ms` }); }, timeoutMs);
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
