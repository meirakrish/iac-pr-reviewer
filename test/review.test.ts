import { describe, expect, it } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { resolveConfig } from "../src/config.js";
import { exceedsThreshold, reviewPlan } from "../src/review.js";
import { renderMarkdown, COMMENT_MARKER } from "../src/report/markdown.js";
import type { LlmReview } from "../src/schema.js";
import { evalPlan } from "./helpers.js";

/** Minimal stand-in for a LangChain chat model: withStructuredOutput(...).invoke() resolves or throws. */
function fakeModel(result: LlmReview | Error): BaseChatModel & { calls: number } {
  const model = {
    calls: 0,
    withStructuredOutput: () => ({
      invoke: async () => {
        model.calls++;
        if (result instanceof Error) throw result;
        return result;
      },
    }),
  };
  return model as unknown as BaseChatModel & { calls: number };
}

const config = resolveConfig({ provider: "ollama", failOn: "high" }, {});

describe("reviewPlan", () => {
  it("merges LLM output with prechecks", async () => {
    const model = fakeModel({
      riskLevel: "high",
      summary: "Grants PassRole on everything.",
      findings: [{ resource: "aws_iam_policy.deployer", severity: "high", category: "iam", issue: "PassRole escalation", blastRadius: "Admin takeover", suggestion: "Scope PassRole" }],
    });
    const r = await reviewPlan(evalPlan("09-iam-passrole-escalation"), config, { model });
    expect(r.riskLevel).toBe("high");
    expect(r.findings).toEqual([expect.objectContaining({ source: "both", severity: "high", ruleId: "iam-privilege-escalation" })]);
    expect(r.llm).toMatchObject({ ok: true, provider: "ollama" });
  });

  it("degrades to prechecks only when the LLM fails", async () => {
    const model = fakeModel(new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    const r = await reviewPlan(evalPlan("04-open-ssh"), config, { model });
    expect(r.riskLevel).toBe("critical");
    expect(r.llm).toMatchObject({ ok: false, error: expect.stringContaining("Ollama") });
    expect(renderMarkdown(r)).toContain("AI review unavailable");
  });

  it("skips the LLM entirely with --no-llm", async () => {
    const model = fakeModel(new Error("should not be called"));
    const r = await reviewPlan(evalPlan("04-open-ssh"), resolveConfig({ noLlm: true }, {}), { model });
    expect(model.calls).toBe(0);
    expect(r.llm.provider).toBe("none");
  });

  it("applies the fail-on threshold", async () => {
    const r = await reviewPlan(evalPlan("11-safe-alb-https"), resolveConfig({ noLlm: true }, {}));
    expect(exceedsThreshold(r, "high")).toBe(false);
    expect(exceedsThreshold(r, "low")).toBe(true);
    expect(exceedsThreshold(r, "none")).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("includes the marker, badge, escapes table cells and collapses low findings", async () => {
    const r = await reviewPlan(evalPlan("11-safe-alb-https"), resolveConfig({ noLlm: true }, {}));
    r.findings.push({ ...r.findings[0]!, severity: "high", issue: "a | b\nc" });
    const md = renderMarkdown(r, { failOn: "high" });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("img.shields.io/badge/risk-low");
    expect(md).toContain("a \\| b c");
    expect(md).toContain("<details><summary>Low-severity findings (1)</summary>");
  });
});

describe("resolveConfig", () => {
  it("prefers explicit input over env, and detects hosted providers from API keys", () => {
    expect(resolveConfig({}, { ANTHROPIC_API_KEY: "x" }).llm).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(resolveConfig({ provider: "ollama" }, { ANTHROPIC_API_KEY: "x", IAC_REVIEW_MODEL: "llama3" }).llm).toMatchObject({ provider: "ollama", model: "llama3" });
    expect(resolveConfig({}, { IAC_REVIEW_REQUIRED_TAGS: "Team, Owner" }).requiredTags).toEqual(["Team", "Owner"]);
  });

  it("rejects invalid values", () => {
    expect(() => resolveConfig({ failOn: "severe" }, {})).toThrow(/fail-on/);
    expect(() => resolveConfig({ provider: "gemini" }, {})).toThrow(/provider/);
  });
});
