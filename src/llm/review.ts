import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { LlmReviewSchema, type ChangeStats, type Finding, type LlmReview } from "../schema.js";
import type { TrimmedPlan } from "../plan/trim.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";

export async function llmReview(
  model: BaseChatModel,
  input: { stats: ChangeStats; prechecks: Finding[]; plan: TrimmedPlan },
  opts: { timeoutMs?: number } = {},
): Promise<LlmReview> {
  const structured = model.withStructuredOutput(LlmReviewSchema, { name: "iac_review" });
  const raw = await structured.invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(buildUserMessage(input))], {
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  // Re-validate: some providers return loosely typed JSON even in structured mode.
  return LlmReviewSchema.parse(raw);
}
