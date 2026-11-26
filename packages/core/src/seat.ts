import { z } from "zod";
import { RoleSchema } from "./roles.js";

export const SeatConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  adapter: z.enum(["xenia", "cli", "fake"]),
  xeniaModel: z.string().optional(),
  cliCommand: z.string().optional(),
  cliArgsTemplate: z.array(z.string()).optional(),
  cliModel: z.string().optional(),
  /**
   * Extra flags for a built-in CLI seat, placed before the prompt — e.g. codex's
   * `["-c", "model_provider=openai"]` to bypass a gateway configured in ~/.codex/config.toml for
   * this seat only. Ignored when `cliArgsTemplate` is set, since a template is the whole argv.
   */
  cliExtraArgs: z.array(z.string()).optional(),
  role: RoleSchema,
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(4096),
  timeoutMs: z.number().int().positive().default(60_000),
  enabled: z.boolean().default(true),
  tier: z.enum(["cheap", "standard", "premium"]).default("standard"),
});
export type SeatConfig = z.infer<typeof SeatConfigSchema>;

/**
 * The 7-seat Xenia council: one model family per concern. Model ids are seed data for a local
 * OmniRoute/Xenia gateway and drift as the gateway's providers change — `conclave doctor` checks
 * each seat's `xeniaModel` against the gateway's live `/v1/models` and suggests close matches.
 * Listed is not the same as answering: a provider behind the gateway can still fail at call time.
 * These seats need no filesystem; the orchestrator sends them the file list and diff.
 *
 * They are reviewers, not a runnable council on their own: the executor that plans, implements,
 * and remediates is always the `claude` CLI seat, so pair them with it (DEFAULT_CLI_SEATS[0]).
 */
export const DEFAULT_SEATS: SeatConfig[] = [
  { id: "gemini", label: "Gemini", adapter: "xenia", xeniaModel: "aug/gemini-3.1-pro-preview", role: "ARCHITECTURE", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "gpt", label: "GPT", adapter: "xenia", xeniaModel: "cx/gpt-5.6-sol", role: "CORRECTNESS", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "kimi", label: "Kimi", adapter: "xenia", xeniaModel: "aug/kimi-k2.7", role: "SPEC_FIDELITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "grok", label: "Grok", adapter: "xenia", xeniaModel: "dva/grok-4-5-medium", role: "SECURITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "glm", label: "GLM", adapter: "xenia", xeniaModel: "dva/glm-5-2", role: "TESTABILITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "deepseek", label: "DeepSeek", adapter: "xenia", xeniaModel: "dva/deepseek-v4", role: "PERFORMANCE", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "mistral", label: "Mistral", adapter: "xenia", xeniaModel: "ddgw/mistral-small-2603", role: "SIMPLICITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
];

/** The deliberately small local-first council used by the CLI MVP. */
export const DEFAULT_CLI_SEATS: SeatConfig[] = [
  { id: "claude", label: "Claude Code", adapter: "cli", cliCommand: "claude", role: "ARCHITECTURE", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "codex", label: "Codex CLI", adapter: "cli", cliCommand: "codex", role: "CORRECTNESS", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "antigravity", label: "Antigravity CLI", adapter: "cli", cliCommand: "agy", role: "TESTABILITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
  { id: "grok", label: "Grok Build", adapter: "cli", cliCommand: "grok", role: "SECURITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 120_000, enabled: true, tier: "standard" },
];
