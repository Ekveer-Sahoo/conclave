import { z } from "zod";
import { RoleSchema } from "./roles.js";

export const SeatConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  adapter: z.enum(["xenia", "cli", "fake"]),
  xeniaModel: z.string().optional(),
  cliCommand: z.string().optional(),
  cliArgsTemplate: z.array(z.string()).optional(),
  role: RoleSchema,
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(4096),
  timeoutMs: z.number().int().positive().default(60_000),
  enabled: z.boolean().default(true),
  tier: z.enum(["cheap", "standard", "premium"]).default("standard"),
});
export type SeatConfig = z.infer<typeof SeatConfigSchema>;

/**
 * The 7 default seats. Model ids are seed data (drift over time) — resolved
 * against the live Xenia provider-plugin-manifest at doctor/startup, never
 * hardcoded beyond this seed.
 */
export const DEFAULT_SEATS: SeatConfig[] = [
  { id: "gemini", label: "Gemini", adapter: "xenia", xeniaModel: "gemini/gemini-3.1-pro-preview", role: "ARCHITECTURE", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
  { id: "codex", label: "Codex", adapter: "xenia", xeniaModel: "openai/gpt-5.6", role: "CORRECTNESS", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
  { id: "kimi", label: "Kimi", adapter: "xenia", xeniaModel: "moonshot/kimi-k3", role: "SPEC_FIDELITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
  { id: "grok", label: "Grok", adapter: "xenia", xeniaModel: "xai/grok-4.3", role: "SECURITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
  { id: "qwen", label: "Qwen", adapter: "xenia", xeniaModel: "alibaba/qwen3.7-max", role: "TESTABILITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
  { id: "deepseek", label: "DeepSeek", adapter: "xenia", xeniaModel: "deepseek/deepseek-v4-pro", role: "PERFORMANCE", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
  { id: "mistral", label: "Mistral", adapter: "xenia", xeniaModel: "mistral/mistral-large-latest", role: "SIMPLICITY", temperature: 0.2, maxTokens: 4096, timeoutMs: 60_000, enabled: true, tier: "standard" },
];
