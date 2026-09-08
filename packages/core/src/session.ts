import { z } from "zod";
import { SeatConfigSchema } from "./seat.js";

export const SessionConfigSchema = z.object({
  task: z.string().min(1),
  repoPath: z.string(),
  budgetCeilingUsd: z.number().positive().default(20),
  minQuorum: z.number().int().min(1).default(3),
  exchangeCapPerThread: z.number().int().positive().default(6),
  ratificationRoundCap: z.number().int().positive().default(3),
  remediationRoundCap: z.number().int().positive().default(3),
  perCallTimeoutMs: z.number().int().positive().default(60_000),
  seats: z.array(SeatConfigSchema).default([]),
  xeniaBaseUrl: z.string().url().default("http://localhost:20128"),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
