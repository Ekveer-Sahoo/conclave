import { z } from "zod";
import { RoleSchema } from "./roles.js";

export const SeveritySchema = z.enum(["BLOCKER", "MAJOR", "MINOR", "NIT"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string(),
  seat: z.string(),
  role: RoleSchema,
  target: z.string(),
  category: z.string(),
  severity: SeveritySchema,
  description: z.string(),
  falsifiable_test: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictSchema = z.object({
  seat: z.string(),
  findings: z.array(FindingSchema),
  overall_verdict: z.enum(["APPROVE", "APPROVE_WITH_CHANGES", "REJECT"]),
  verdict_reasoning: z.string(),
  raw_usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }),
  compression: z
    .object({
      before: z.number().int().nonnegative(),
      after: z.number().int().nonnegative(),
      rules: z.array(z.string()),
    })
    .optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
