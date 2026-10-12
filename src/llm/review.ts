import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { trimToSentence, type LlmClient } from "@meirakrish/llm-kit";
import {
  LlmReviewSchema,
  REVIEW_LIMITS,
  TEXT_LIMITS,
  type ChangeStats,
  type Finding,
  type LlmReview,
} from "../schema.js";
import type { TrimmedPlan } from "../plan/trim.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";

/**
 * Ask the LLM to review the trimmed plan. llm-kit handles timeouts, validation against LlmReviewSchema,
 * the retry for unusable output, and length limits on small local models.
 */
export async function llmReview(
  llm: LlmClient,
  input: { stats: ChangeStats; prechecks: Finding[]; plan: TrimmedPlan },
): Promise<LlmReview> {
  const messages = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(buildUserMessage(input))];
  const review = await llm.structured(LlmReviewSchema, messages, { name: "iac_review", limits: REVIEW_LIMITS });
  return tidy(review);
}

/** Answers cut off by a length limit end mid-sentence; trim them back to the last complete one. */
function tidy(r: LlmReview): LlmReview {
  return {
    ...r,
    summary: trimToSentence(r.summary, TEXT_LIMITS.summary),
    findings: r.findings.map((f) => ({
      ...f,
      issue: trimToSentence(f.issue, TEXT_LIMITS.field),
      blastRadius: trimToSentence(f.blastRadius, TEXT_LIMITS.field),
      suggestion: trimToSentence(f.suggestion, TEXT_LIMITS.field),
    })),
  };
}
