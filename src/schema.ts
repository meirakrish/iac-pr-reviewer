import { z } from "zod";
import { LlmRunInfo, maxSeverity, Severity, SEVERITY_ORDER, type SchemaLimits } from "@meirakrish/llm-kit";

// The severity scale is shared with the other llm-kit tools.
export { maxSeverity, Severity, SEVERITY_ORDER };

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

export const TEXT_LIMITS = { summary: 700, field: 400, resource: 200, findings: 20 };

/**
 * Length limits for the LLM's free-text fields. Constrained decoders (Ollama/llama.cpp grammars) enforce them,
 * which stops small models from writing one string forever; llm-kit applies them only where they are enforced.
 */
export const REVIEW_LIMITS: SchemaLimits = {
  summary: TEXT_LIMITS.summary,
  findings: TEXT_LIMITS.findings,
  "findings[].resource": TEXT_LIMITS.resource,
  "findings[].issue": TEXT_LIMITS.field,
  "findings[].blastRadius": TEXT_LIMITS.field,
  "findings[].suggestion": TEXT_LIMITS.field,
};

export const FindingSource = z.enum(["precheck", "llm", "both"]);

export const Finding = LlmFinding.extend({
  source: FindingSource,
  ruleId: z.string().nullable(),
  /** Set when one finding covers several resources, e.g. every resource in a renamed module. */
  relatedResources: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ChangeStats = z.object({
  create: z.number(),
  update: z.number(),
  delete: z.number(),
  replace: z.number(),
  /** Renamed via `moved` blocks (same object, new address). */
  moved: z.number(),
});
export type ChangeStats = z.infer<typeof ChangeStats>;

export const ReviewResult = z.object({
  riskLevel: Severity,
  summary: z.string(),
  findings: z.array(Finding),
  stats: ChangeStats,
  llm: LlmRunInfo,
});
export type ReviewResult = z.infer<typeof ReviewResult>;
