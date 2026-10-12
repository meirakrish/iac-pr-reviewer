import { describe, expect, it } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { resolveConfig } from "../src/config.js";
import { exceedsThreshold, reviewPlan } from "../src/review.js";
import { renderMarkdown, COMMENT_MARKER } from "../src/report/markdown.js";
import { LlmReviewSchema, REVIEW_LIMITS, type LlmReview } from "../src/schema.js";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { boundedJsonSchema } from "@meirakrish/llm-kit";
import { evalPlan } from "./helpers.js";

/**
 * Minimal stand-in for a LangChain chat model.
 * withStructuredOutput(...).invoke() resolves or throws, using one result per call.
 */
function fakeModel(...results: (LlmReview | Error)[]): BaseChatModel & { calls: number } {
  const model = {
    calls: 0,
    withStructuredOutput: () => ({
      invoke: async () => {
        const result = results[Math.min(model.calls, results.length - 1)]!;
        model.calls++;
        if (result instanceof Error) throw result;
        return result;
      },
    }),
  };
  return model as unknown as BaseChatModel & { calls: number };
}

const config = resolveConfig({ provider: "ollama", failOn: "high" }, {});
const quiet = () => {};

describe("reviewPlan", () => {
  it("merges LLM output with prechecks", async () => {
    const model = fakeModel({
      riskLevel: "high",
      summary: "Grants PassRole on everything.",
      findings: [
        {
          resource: "aws_iam_policy.deployer",
          severity: "high",
          category: "iam",
          issue: "PassRole escalation",
          blastRadius: "Admin takeover",
          suggestion: "Scope PassRole",
        },
      ],
    });
    const r = await reviewPlan(evalPlan("09-iam-passrole-escalation"), config, { model });
    expect(r.riskLevel).toBe("high");
    expect(r.findings).toEqual([
      expect.objectContaining({ source: "both", severity: "high", ruleId: "iam-privilege-escalation" }),
    ]);
    expect(r.llm).toMatchObject({ ok: true, provider: "ollama" });
    expect(r.llm.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("degrades to prechecks only when the LLM fails", async () => {
    const model = fakeModel(new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    const r = await reviewPlan(evalPlan("04-open-ssh"), config, { model });
    expect(r.riskLevel).toBe("critical");
    expect(r.llm).toMatchObject({ ok: false, error: expect.stringContaining("Ollama") });
    expect(renderMarkdown(r)).toContain("AI review unavailable");
  });

  it("retries once when the model returns unusable output", async () => {
    const good: LlmReview = { riskLevel: "critical", summary: "SSH is open.", findings: [] };
    const model = fakeModel(new Error('Failed to parse. Text: "{ \\n\\n\\n"'), good);
    const r = await reviewPlan(evalPlan("04-open-ssh"), config, { model });
    expect(model.calls).toBe(2);
    expect(r.llm.ok).toBe(true);
    expect(r.summary).toBe("SSH is open.");
  });

  it("does not retry connection errors", async () => {
    const model = fakeModel(new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    await reviewPlan(evalPlan("04-open-ssh"), config, { model });
    expect(model.calls).toBe(1);
  });

  it("skips the LLM entirely with --no-llm", async () => {
    const model = fakeModel(new Error("should not be called"));
    const r = await reviewPlan(evalPlan("04-open-ssh"), resolveConfig({ noLlm: true }, {}), { model });
    expect(model.calls).toBe(0);
    expect(r.llm.provider).toBe("none");
  });

  it("skips the LLM without reporting a failure when nothing changes", async () => {
    const model = fakeModel(new Error("should not be called"));
    const r = await reviewPlan(evalPlan("24-module-rename-with-moved"), config, { model });
    expect(model.calls).toBe(0);
    expect(r.llm).toMatchObject({ provider: "ollama", ok: false, error: null });
    expect(r.summary).toContain("3 resources are only renamed");
    expect(renderMarkdown(r)).toContain("no AI review was needed");
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
    expect(resolveConfig({}, { ANTHROPIC_API_KEY: "x" }).llm).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(
      resolveConfig({ provider: "ollama" }, { ANTHROPIC_API_KEY: "x", IAC_REVIEW_MODEL: "llama3" }, quiet).llm,
    ).toMatchObject({ provider: "ollama", model: "llama3" });
    expect(resolveConfig({}, { IAC_REVIEW_REQUIRED_TAGS: "Team, Owner" }).requiredTags).toEqual(["Team", "Owner"]);
  });

  it("accepts OLLAMA_HOST with or without a scheme", () => {
    expect(resolveConfig({}, { OLLAMA_HOST: "127.0.0.1:11434" }).llm?.ollamaHost).toBe("http://127.0.0.1:11434");
    expect(resolveConfig({}, { OLLAMA_HOST: "https://ollama.internal" }).llm?.ollamaHost).toBe(
      "https://ollama.internal",
    );
    expect(resolveConfig({}, {}).llm?.ollamaHost).toBe("http://localhost:11434");
  });

  it("reads the shared LLM_* settings, and the old IAC_REVIEW_* names with a warning", () => {
    expect(resolveConfig({}, { LLM_MODEL: "llama3", LLM_NUM_CTX: "8192" }).llm).toMatchObject({
      model: "llama3",
      numCtx: 8192,
    });
    const warnings: string[] = [];
    const legacy = resolveConfig({}, { IAC_REVIEW_NUM_CTX: "8192" }, (m) => warnings.push(m));
    expect(legacy.llm?.numCtx).toBe(8192);
    expect(warnings).toEqual(["IAC_REVIEW_NUM_CTX is deprecated; use LLM_NUM_CTX"]);
    const both = resolveConfig({}, { IAC_REVIEW_MODEL: "old", LLM_MODEL: "new" }, quiet);
    expect(both.llm?.model).toBe("new");
  });

  it("rejects invalid values", () => {
    expect(() => resolveConfig({ failOn: "severe" }, {})).toThrow(/fail-on/);
    expect(() => resolveConfig({ provider: "gemini" }, {})).toThrow(/provider/);
  });
});

describe("REVIEW_LIMITS", () => {
  it("bounds the review's free-text fields without mutating the schema shared with hosted providers", () => {
    const bounded = boundedJsonSchema(LlmReviewSchema, REVIEW_LIMITS);
    expect(bounded.properties.summary.maxLength).toBe(700);
    expect(bounded.properties.findings.maxItems).toBe(20);
    expect(bounded.properties.findings.items.properties.issue.maxLength).toBe(400);
    expect((toJsonSchema(LlmReviewSchema) as any).properties.summary.maxLength).toBeUndefined();
  });
});
