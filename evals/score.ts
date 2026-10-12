import { z } from "zod";
import { Category, SEVERITY_ORDER, Severity, type Finding, type ReviewResult } from "../src/schema.js";
import { sameIssue } from "../src/report/match.js";

export const ExpectedFinding = z.object({
  resource: z.string(),
  /** Omit to accept any category for this resource. */
  category: Category.optional(),
  minSeverity: Severity,
  /** Prechecks cannot catch this; only the LLM can. */
  llmOnly: z.boolean().default(false),
  /** A valid finding that isn't required: not counted toward recall, but not penalized as "extra" either. */
  optional: z.boolean().default(false),
});

export const Expected = z.object({
  description: z.string(),
  risk: z.object({ min: Severity, max: Severity }),
  findings: z.array(ExpectedFinding),
});
export type Expected = z.infer<typeof Expected>;

export interface CaseScore {
  riskOk: boolean;
  hits: number;
  /** Matched the resource/category but with severity below minSeverity. */
  underRated: string[];
  missed: string[];
  /** Medium+ findings that no expected finding accounts for (low-severity extras are ignored). */
  extra: string[];
  llmOnlyHits: number;
  llmOnlyTotal: number;
}

export function scoreCase(result: ReviewResult, expected: Expected): CaseScore {
  const used = new Set<Finding>();
  const score: CaseScore = {
    riskOk: false,
    hits: 0,
    underRated: [],
    missed: [],
    extra: [],
    llmOnlyHits: 0,
    llmOnlyTotal: 0,
  };

  const r = SEVERITY_ORDER[result.riskLevel];
  score.riskOk = r >= SEVERITY_ORDER[expected.risk.min] && r <= SEVERITY_ORDER[expected.risk.max];

  for (const exp of expected.findings.filter((e) => !e.optional)) {
    const label = `${exp.resource}${exp.category ? `/${exp.category}` : ""}`;
    if (exp.llmOnly) score.llmOnlyTotal++;
    const candidates = result.findings.filter(
      (f) =>
        !used.has(f) &&
        (exp.category ? sameIssue(f, { resource: exp.resource, category: exp.category }) : f.resource === exp.resource),
    );
    const hit = candidates.find((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[exp.minSeverity]);
    if (hit) {
      used.add(hit);
      score.hits++;
      if (exp.llmOnly) score.llmOnlyHits++;
    } else if (candidates.length) {
      used.add(candidates[0]!);
      score.underRated.push(`${label} (got ${candidates[0]!.severity}, want ≥${exp.minSeverity})`);
    } else {
      score.missed.push(label);
    }
  }

  // Several findings on the same expected resource/category group (e.g. LLM restating a precheck) are not "extra".
  const explained = (f: Finding) =>
    expected.findings.some((e) =>
      e.category ? sameIssue(f, { resource: e.resource, category: e.category }) : f.resource === e.resource,
    );
  score.extra = result.findings
    .filter((f) => !used.has(f) && !explained(f) && SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.medium)
    .map((f) => `${f.resource}/${f.category} (${f.severity}, ${f.source})`);

  return score;
}

export interface Aggregate {
  cases: number;
  riskAccuracy: number;
  recall: number;
  precision: number;
  llmOnlyRecall: number | null;
}

export function aggregate(scores: CaseScore[]): Aggregate {
  const sum = (f: (s: CaseScore) => number) => scores.reduce((n, s) => n + f(s), 0);
  const expectedTotal = sum((s) => s.hits + s.underRated.length + s.missed.length);
  const hits = sum((s) => s.hits);
  const reported = hits + sum((s) => s.extra.length);
  const llmOnlyTotal = sum((s) => s.llmOnlyTotal);
  return {
    cases: scores.length,
    riskAccuracy: sum((s) => (s.riskOk ? 1 : 0)) / (scores.length || 1),
    recall: expectedTotal ? hits / expectedTotal : 1,
    precision: reported ? hits / reported : 1,
    llmOnlyRecall: llmOnlyTotal ? sum((s) => s.llmOnlyHits) / llmOnlyTotal : null,
  };
}
