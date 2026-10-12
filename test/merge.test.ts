import { describe, expect, it } from "vitest";
import { mergeReview, type MergeInput } from "../src/report/merge.js";
import type { Finding, LlmFinding, LlmReview } from "../src/schema.js";
import type { ChangeKind } from "../src/plan/types.js";

const stats = { create: 1, update: 0, delete: 1, replace: 0, moved: 0 };
const llmMeta = { provider: "test", model: "test", ok: true, error: null };

const pre: Finding = {
  resource: "aws_db_instance.orders",
  severity: "critical",
  category: "data-loss",
  issue: "Stateful resource will be destroyed.",
  blastRadius: "generic",
  suggestion: "generic",
  source: "precheck",
  ruleId: "resource-destroy",
};

const llmFinding = (o: Partial<LlmFinding>): LlmFinding => ({
  resource: "aws_db_instance.orders",
  severity: "high",
  category: "destroy",
  issue: "LLM issue",
  blastRadius: "Orders API loses its database.",
  suggestion: "Restore the resource block.",
  ...o,
});

const defaultActions: [string, ChangeKind][] = [
  ["aws_db_instance.orders", "delete"],
  ["aws_iam_role.x", "create"],
];

function merge(prechecks: Finding[], llm: LlmReview | null, actions = defaultActions) {
  const input: MergeInput = { prechecks, llm, llmMeta, stats, actions: new Map(actions) };
  return mergeReview(input);
}

describe("mergeReview", () => {
  it("never lets the LLM downgrade a precheck finding or the overall risk", () => {
    const r = merge([pre], { riskLevel: "low", summary: "fine", findings: [llmFinding({ severity: "low" })] });
    expect(r.riskLevel).toBe("critical");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      severity: "critical",
      source: "both",
      issue: pre.issue,
      blastRadius: "Orders API loses its database.",
    });
  });

  it("keeps the rule's explanation when the LLM's text is just a severity word", () => {
    const r = merge([pre], {
      riskLevel: "critical",
      summary: "s",
      findings: [llmFinding({ blastRadius: "High", suggestion: "Medium" })],
    });
    expect(r.findings[0]).toMatchObject({ source: "both", blastRadius: pre.blastRadius, suggestion: pre.suggestion });
  });

  it("never replaces an exact computed fix with the LLM's suggestion", () => {
    const moved: Finding = {
      ...pre,
      ruleId: "missing-moved-block",
      suggestion: "Add a `moved` block with `from = module.a` and `to = module.b`.",
    };
    const r = merge([moved], {
      riskLevel: "critical",
      summary: "s",
      findings: [llmFinding({ suggestion: "Enable backups and deletion protection on the database." })],
    });
    expect(r.findings[0]).toMatchObject({
      source: "both",
      suggestion: moved.suggestion,
      blastRadius: "Orders API loses its database.",
    });
  });

  it("folds LLM findings about resources covered by a multi-resource finding into it", () => {
    const moduleMove: Finding = {
      ...pre,
      resource: "module.old",
      ruleId: "missing-moved-block",
      relatedResources: ["module.old.aws_db_instance.this", "module.old.aws_s3_bucket.logs"],
    };
    const r = merge(
      [moduleMove],
      {
        riskLevel: "critical",
        summary: "s",
        findings: [
          llmFinding({ resource: "module.old.aws_db_instance.this" }),
          llmFinding({ resource: "module.old.aws_s3_bucket.logs", category: "data-loss" }),
        ],
      },
      [
        ["module.old.aws_db_instance.this", "delete"],
        ["module.old.aws_s3_bucket.logs", "delete"],
      ],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ resource: "module.old", source: "both" });
  });

  it("drops low-severity notes the LLM adds on its own", () => {
    const r = merge([], {
      riskLevel: "low",
      summary: "s",
      findings: [
        llmFinding({ resource: "aws_iam_role.x", category: "other", severity: "low", issue: "Routine tag change." }),
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it("drops LLM-only claims about updates whose new values are all unknown until apply", () => {
    const claim = llmFinding({ resource: "aws_iam_role.x", category: "iam", severity: "medium" });
    const input: MergeInput = {
      prechecks: [],
      llm: { riskLevel: "medium", summary: "s", findings: [claim] },
      llmMeta,
      stats,
      actions: new Map(defaultActions),
      opaque: new Set(["aws_iam_role.x"]),
    };
    expect(mergeReview(input).findings).toEqual([]);
  });

  it("adds an exact computed fix to the summary when the LLM summary leaves it out", () => {
    const moved: Finding = {
      ...pre,
      ruleId: "missing-moved-block",
      suggestion: "Add a `moved` block with `from = module.a` and `to = module.b`.",
    };
    const r = merge([moved], { riskLevel: "critical", summary: "Plan a data migration first.", findings: [] });
    expect(r.summary).toBe(
      "Plan a data migration first.\n\n**Fix:** Add a `moved` block with `from = module.a` and `to = module.b`.",
    );
    const already = merge([moved], { riskLevel: "critical", summary: "Add a `moved` block instead.", findings: [] });
    expect(already.summary).toBe("Add a `moved` block instead.");
  });

  it("keeps precheck findings the LLM did not mention", () => {
    const r = merge([pre], { riskLevel: "critical", summary: "s", findings: [] });
    expect(r.findings[0]!.source).toBe("precheck");
  });

  it("lets the LLM raise severity and add new findings", () => {
    const r = merge([], {
      riskLevel: "high",
      summary: "s",
      findings: [llmFinding({ resource: "aws_iam_role.x", category: "iam" })],
    });
    expect(r.riskLevel).toBe("high");
    expect(r.findings[0]).toMatchObject({ source: "llm", ruleId: null });
  });

  it("drops LLM findings about resources not in the plan", () => {
    const r = merge([], {
      riskLevel: "low",
      summary: "s",
      findings: [llmFinding({ resource: "aws_s3_bucket.imaginary" })],
    });
    expect(r.findings).toEqual([]);
  });

  it("drops destroy/replace claims about resources that are only being created", () => {
    const r = merge([], {
      riskLevel: "medium",
      summary: "s",
      findings: [llmFinding({ resource: "aws_iam_role.x", category: "destroy", severity: "medium" })],
    });
    expect(r.findings).toEqual([]);
  });

  it("dedupes repeated LLM findings for the same resource + category group", () => {
    const r = merge([], {
      riskLevel: "medium",
      summary: "s",
      findings: [
        llmFinding({ resource: "aws_iam_role.x", category: "iam", severity: "medium" }),
        llmFinding({ resource: "aws_iam_role.x", category: "iam", severity: "high" }),
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("high");
  });

  it("falls back to a deterministic summary when the LLM is unavailable", () => {
    const r = merge([pre], null);
    expect(r.riskLevel).toBe("critical");
    expect(r.summary).toMatch(/changes 2 resources.*1 issue, 1 of them high or critical/);
  });
});
