import { z } from "zod";

export const RoleSchema = z.enum([
  "CORRECTNESS",
  "ARCHITECTURE",
  "SECURITY",
  "PERFORMANCE",
  "SPEC_FIDELITY",
  "TESTABILITY",
  "SIMPLICITY",
]);
export type Role = z.infer<typeof RoleSchema>;

export const PhaseSchema = z.enum([
  "INTAKE",
  "PLAN",
  "PLAN_AUDIT",
  "PLAN_REFINE",
  "DELIBERATE",
  "RATIFY_PLAN",
  "EXECUTE",
  "WORK_AUDIT",
  "WORK_REFINE",
  "REMEDIATE",
  "RE_AUDIT",
  "RATIFY_WORK",
  "REPORT",
]);
export type Phase = z.infer<typeof PhaseSchema>;
