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
  /**
   * A model's self-reported token counts. Never used for spend — real usage comes from the
   * provider's own envelope — and no longer asked of models: requiring a field a model cannot
   * actually know made a live seat fail its vote five times over omitting it. Still accepted, since
   * older events and scripted providers carry it.
   */
  raw_usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
    })
    .optional(),
  compression: z
    .object({
      before: z.number().int().nonnegative(),
      after: z.number().int().nonnegative(),
      rules: z.array(z.string()),
    })
    .optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
