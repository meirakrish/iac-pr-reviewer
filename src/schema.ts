import { z } from "zod";

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxSeverity(levels: Iterable<Severity>, floor: Severity = "low"): Severity {
  let max = floor;
  for (const l of levels) if (SEVERITY_ORDER[l] > SEVERITY_ORDER[max]) max = l;
  return max;
}

export const Category = z.enum([
  "destroy",
  "replace",
  "iam",
  "network-exposure",
  "public-storage",
  "encryption",
  "tagging",
  "data-loss",
  "cost",
  "other",
]);
export type Category = z.infer<typeof Category>;

// Returned by the LLM. Descriptions are forwarded to the model by LangChain.
// .nullable() rather than .optional() keeps OpenAI strict mode happy.
export const LlmFinding = z.object({
  resource: z.string().describe("Terraform resource address exactly as in the plan, e.g. aws_s3_bucket.logs"),
  severity: Severity.describe("Severity of this specific finding"),
  category: Category.describe("Closest category; use 'other' if none fits"),
  issue: z.string().describe("What is risky, in one or two sentences"),
  blastRadius: z.string().describe("What breaks or gets exposed if this goes wrong"),
  suggestion: z.string().describe("A concrete fix or mitigation"),
});
export type LlmFinding = z.infer<typeof LlmFinding>;

export const LlmReviewSchema = z.object({
  riskLevel: Severity.describe("Overall risk of applying this plan"),
  summary: z.string().describe("2-4 sentence plain-English summary for a code reviewer"),
  findings: z.array(LlmFinding),
});
export type LlmReview = z.infer<typeof LlmReviewSchema>;

export const FindingSource = z.enum(["precheck", "llm", "both"]);

export const Finding = LlmFinding.extend({
  source: FindingSource,
  ruleId: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const ChangeStats = z.object({
  create: z.number(),
  update: z.number(),
  delete: z.number(),
  replace: z.number(),
});
export type ChangeStats = z.infer<typeof ChangeStats>;

export const ReviewResult = z.object({
  riskLevel: Severity,
  summary: z.string(),
  findings: z.array(Finding),
  stats: ChangeStats,
  llm: z.object({
    provider: z.string(),
    model: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});
export type ReviewResult = z.infer<typeof ReviewResult>;
