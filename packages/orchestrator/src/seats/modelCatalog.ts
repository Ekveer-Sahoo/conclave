import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SeatConfig } from "@conclave/core";
import { cliKind, killProcessTree } from "./cliAdapter.js";
import { xeniaAuthHeaders, xeniaBaseUrl } from "./xeniaAdapter.js";

export interface ModelOption {
  id: string;
  label?: string;
  /** Pickers group options by this; ids without one are grouped by their `provider/` prefix, if any. */
  group?: string;
}

/**
 * What a seat can be switched to, and how much to trust the list. `authoritative` lists come from
 * the provider itself (a gateway's /v1/models, `agy models`): an id outside them will not work.
 * The others are known ids plus whatever the CLI's own config names — any id the CLI accepts is
 * still allowed, so the list is a suggestion, never a gate.
 */
export interface ModelCatalog {
  seat: string;
  adapter: SeatConfig["adapter"];
  /** The model this seat is configured to use; undefined means the CLI's own default. */
  current?: string;
  /** What "default" resolves to, when the CLI's config says. */
  defaultModel?: string;
  defaultSource?: string;
  models: ModelOption[];
  source: string;
  authoritative: boolean;
  note?: string;
  /** Set when the provider could not be asked; `models` then holds whatever is known offline. */
  error?: string;
}

/**
 * Claude Code has no command that lists models. It accepts these aliases (which follow your Claude
 * Code settings, so they may be remapped there) and full ids; any other id it accepts works too.
 */
const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", group: "Models" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", group: "Models" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Models" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", group: "Models" },
  { id: "fable", label: "Latest Fable", group: "Aliases" },
  { id: "opus", label: "Latest Opus", group: "Aliases" },
  { id: "sonnet", label: "Latest Sonnet", group: "Aliases" },
  { id: "haiku", label: "Latest Haiku", group: "Aliases" },
];

const CATALOG_TIMEOUT_MS = 15_000;

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** A TOML string value (`"…"` or `'…'`) for `key` in one section, ignoring trailing comments. */
function tomlString(section: string, key: string): string | undefined {
  const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, "m").exec(section);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** Codex's config.toml split into its top level and its `[table]` sections. */
function readCodexConfig(): { top: string; tables: Map<string, string> } | undefined {
  let toml: string;
  try {
    toml = readFileSync(join(codexHome(), "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  const tables = new Map<string, string>();
  // A header may carry a trailing comment; `[[array]]` tables are not settings Codex routing uses.
  const parts = toml.split(/^[ \t]*\[([^\[\]]+)\][ \t]*(?:#.*)?\r?$/m);
  for (let index = 1; index < parts.length; index += 2) tables.set(parts[index]!.trim().replace(/"/g, ""), parts[index + 1] ?? "");
  return { top: parts[0] ?? "", tables };
}

/** `-c key=value` / `--config key=value` / `--profile name` overrides in a seat's own Codex flags. */
function codexFlagOverrides(seat: SeatConfig): { values: Map<string, string>; profile?: string } {
  const args = seat.cliExtraArgs ?? [];
  const values = new Map<string, string>();
  let profile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const inline = /^--(config|profile)=(.*)$/.exec(arg);
    const [flag, value] = inline ? [`--${inline[1]}`, inline[2]!] : [arg, args[index + 1]];
    if (value === undefined) continue;
    if (flag === "-c" || flag === "--config") {
      const eq = value.indexOf("=");
      if (eq > 0) values.set(value.slice(0, eq).trim(), value.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2"));
    } else if (flag === "-p" || flag === "--profile") {
      profile = value;
    } else continue;
    if (!inline) index += 1;
  }
  return { values, profile };
}

/**
 * The Codex settings a seat actually runs with: its own `-c`/`--profile` flags first, then the
 * active profile's table in config.toml, then config.toml's top level.
 */
function codexSetting(seat: SeatConfig, key: "model" | "model_provider"): string | undefined {
  const flags = codexFlagOverrides(seat);
  if (flags.values.has(key)) return flags.values.get(key);
  const config = readCodexConfig();
  if (!config) return undefined;
  const profile = flags.profile ?? tomlString(config.top, "profile");
  const fromProfile = profile ? tomlString(config.tables.get(`profiles.${profile}`) ?? "", key) : undefined;
  return fromProfile ?? tomlString(config.top, key);
}

/** What "default" means for a Codex seat: the model its config (or its own flags) names. */
function codexConfiguredModel(seat: SeatConfig): string | undefined {
  return codexSetting(seat, "model");
}

/**
 * The provider Codex is configured to route through (`model_provider` + `[model_providers.<name>]`),
 * when it is a custom OpenAI-compatible endpoint rather than OpenAI itself. Only then is Codex's own
 * model cache beside the point: the models that work are whatever that endpoint serves.
 */
function codexCustomProvider(seat: SeatConfig): { name: string; baseUrl: string; envKey?: string } | undefined {
  const name = codexSetting(seat, "model_provider");
  const config = readCodexConfig();
  if (!config || !name || name === "openai") return undefined;
  const table = config.tables.get(`model_providers.${name}`);
  const baseUrl = table && tomlString(table, "base_url");
  return baseUrl ? { name, baseUrl: baseUrl.replace(/\/+$/, ""), envKey: tomlString(table!, "env_key") } : undefined;
}

/**
 * OpenAI/Codex-family models from a gateway listing, as the bare ids Codex sends. A gateway exposes
 * its Codex route under prefixes ("codex/gpt-6-sol", "cx/gpt-6-sol") and resolves the bare id to it;
 * other providers' GPT routes (e.g. "dva/…") are not Codex and are left out. Newest family first.
 */
export function codexModelsFromGateway(ids: string[]): ModelOption[] {
  const bare = new Set<string>();
  for (const id of ids) {
    const match = /^(?:(codex|cx)\/)?([^/]+)$/.exec(id);
    if (!match) continue;
    const model = match[2]!;
    if (/^(gpt|o\d|codex)/i.test(model)) bare.add(model);
  }
  const version = (id: string) => Number(/(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return [...bare].sort((a, b) => version(b) - version(a) || a.localeCompare(b)).map((id) => ({ id }));
}

/** The models Codex last fetched for this account (its own cache); empty when it last ran through a gateway. */
function codexCachedModels(): ModelOption[] {
  try {
    const cache = JSON.parse(readFileSync(join(codexHome(), "models_cache.json"), "utf8")) as {
      models?: Array<{ slug?: string; display_name?: string; visibility?: string }>;
    };
    return (cache.models ?? [])
      .filter((model) => model.slug && model.visibility !== "hide")
      .map((model) => ({ id: model.slug!, label: model.display_name }));
  } catch {
    return [];
  }
}

/** `<cli> models` → "id<TAB>label" lines (Antigravity's format). */
function listCliModels(command: string, timeoutMs: number): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    // Detached so a timeout kills the whole tree, not just a wrapper script.
    const child = spawn(command, ["models"], { stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
      setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000).unref();
      reject(new Error(`\`${command} models\` timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`\`${command} models\` exited ${code}: ${stderr.trim().slice(0, 200)}`));
      const models = stdout
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter(([id]) => id && /^[\w.:/-]+$/.test(id.trim()))
        .map(([id, label]) => ({ id: id!.trim(), label: label?.trim() || undefined }));
      resolve(models);
    });
  });
}

async function gatewayModels(timeoutMs: number, fetchImpl: typeof fetch): Promise<ModelOption[]> {
  const response = await fetchImpl(`${xeniaBaseUrl()}/v1/models`, {
    headers: xeniaAuthHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`gateway responded ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).filter((model) => typeof model.id === "string").map((model) => ({ id: model.id! }));
}

export async function modelCatalog(
  seat: SeatConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelCatalog> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const base = { seat: seat.id, adapter: seat.adapter };
  if (seat.adapter === "fake") {
    return { ...base, models: [], source: "none", authoritative: false, note: "Fake seats answer in-process and ignore the model." };
  }
  if (seat.adapter === "xenia") {
    try {
      return {
        ...base,
        current: seat.xeniaModel,
        models: await gatewayModels(timeoutMs, options.fetchImpl ?? fetch),
        source: `${xeniaBaseUrl()}/v1/models`,
        authoritative: true,
        note: "Listed by the gateway. A listed model can still fail upstream, so test before relying on it.",
      };
    } catch (error) {
      return { ...base, current: seat.xeniaModel, models: [], source: "gateway", authoritative: false, error: `Could not reach the gateway: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const current = seat.cliModel;
  switch (cliKind(seat)) {
    case "claude":
      return {
        ...base,
        current,
        models: CLAUDE_MODELS,
        source: "known Claude models",
        authoritative: false,
        note: "Claude Code has no model list. Aliases follow your Claude Code settings, which can remap them; a full id is exact. Any id Claude Code accepts works.",
      };
    case "codex": {
      const defaultModel = codexConfiguredModel(seat);
      const withDefault = (models: ModelOption[]) =>
        defaultModel && !models.some((model) => model.id === defaultModel) ? [{ id: defaultModel, label: "Your Codex default" }, ...models] : models;
      const common = { ...base, current, defaultModel, defaultSource: defaultModel ? join(codexHome(), "config.toml") : undefined, authoritative: false };
      // Codex routed through a gateway: its own cache stays empty, and what counts is what that
      // gateway serves for Codex.
      const provider = codexCustomProvider(seat);
      if (provider) {
        try {
          const key = provider.envKey ? process.env[provider.envKey]?.trim() : undefined;
          const response = await (options.fetchImpl ?? fetch)(`${provider.baseUrl}/models`, {
            headers: key ? { authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) throw new Error(`responded ${response.status}`);
          const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
          const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string");
          return {
            ...common,
            models: withDefault(codexModelsFromGateway(ids)),
            source: `your Codex provider "${provider.name}" (${provider.baseUrl})`,
            note: "Codex routes through this provider (set in its config.toml), so these are the models it can reach. Any id the provider accepts works.",
          };
        } catch (error) {
          return { ...common, models: withDefault(codexCachedModels()), source: "your Codex config", error: `Could not list models from Codex's provider "${provider.name}": ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      const cached = codexCachedModels();
      return {
        ...common,
        models: withDefault(cached),
        source: cached.length ? "Codex's model cache for your account" : "your Codex config",
        note: "The models your OpenAI account can use in Codex. Any id Codex accepts works.",
      };
    }
    case "antigravity":
      try {
        const models = await listCliModels(seat.cliCommand ?? "agy", timeoutMs);
        // An empty list (e.g. signed out) says nothing about which ids work, so it gates nothing.
        return { ...base, current, models, source: "agy models", authoritative: models.length > 0, ...(models.length ? {} : { note: "agy listed no models (is it signed in?). Any id agy accepts works." }) };
      } catch (error) {
        return { ...base, current, models: [], source: "agy models", authoritative: false, error: error instanceof Error ? error.message : String(error) };
      }
    default:
      return { ...base, current, models: [], source: "none", authoritative: false, note: "No model list is known for this CLI; any id it accepts works." };
  }
}

/**
 * Per-run model overrides (`--model codex=gpt-6-sol`): returns the seats with each named seat's
 * model replaced for this run only. The result is what gets recorded in the session's
 * configuration, so a resume keeps using the overridden models.
 */
export function applyModelOverrides(seats: SeatConfig[], overrides: Record<string, string | null | undefined>): SeatConfig[] {
  const unknown = Object.keys(overrides).filter((id) => !seats.some((seat) => seat.id === id));
  if (unknown.length > 0) {
    throw new Error(`no seat named ${unknown.join(", ")}; seats are ${seats.map((seat) => seat.id).join(", ")}`);
  }
  return seats.map((seat) => {
    if (!Object.hasOwn(overrides, seat.id)) return seat;
    const model = overrides[seat.id]?.trim() || undefined;
    if (seat.adapter === "xenia") {
      if (!model) throw new Error(`${seat.id} is a xenia seat and needs a model`);
      return { ...seat, xeniaModel: model };
    }
    if (seat.adapter === "cli") return { ...seat, cliModel: model };
    return seat;
  });
}

/** Parses repeated `seat=model` arguments. */
export function parseModelOverrides(args: string[]): Record<string, string> {
  const overrides: Array<[string, string]> = [];
  for (const arg of args) {
    const index = arg.indexOf("=");
    if (index <= 0 || index === arg.length - 1) throw new Error(`expected --model <seat>=<model>, got "${arg}"`);
    overrides.push([arg.slice(0, index).trim(), arg.slice(index + 1).trim()]);
  }
  // fromEntries defines own properties, so a seat named "__proto__" cannot reach the prototype.
  return Object.fromEntries(overrides);
}
