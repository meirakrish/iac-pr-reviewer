import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { boundedReviewJsonSchema, LlmReviewSchema, TEXT_LIMITS, type ChangeStats, type Finding, type LlmReview } from "../schema.js";
import type { TrimmedPlan } from "../plan/trim.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";

export async function llmReview(
  model: BaseChatModel,
  input: { stats: ChangeStats; prechecks: Finding[]; plan: TrimmedPlan },
  opts: { timeoutMs?: number; log?: (msg: string) => void; boundedOutput?: boolean } = {},
): Promise<LlmReview> {
  const schema = opts.boundedOutput ? boundedReviewJsonSchema() : LlmReviewSchema;
  const structured = model.withStructuredOutput(schema, { name: "iac_review" });
  const messages = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(buildUserMessage(input))];
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;

  // One retry for unusable output (truncated or invalid JSON); connection errors and timeouts fail fast.
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await structured.invoke(messages, { signal });
      // Re-validate: some providers return loosely typed JSON even in structured mode.
      return tidy(LlmReviewSchema.parse(raw));
    } catch (err) {
      if (attempt >= 2 || isTransportError(err) || signal?.aborted) throw err;
      opts.log?.(`LLM returned unusable output, retrying once: ${(err as Error).message?.split("\n")[0]?.slice(0, 120)}`);
    }
  }
}

function isTransportError(err: unknown): boolean {
  const e = err as { name?: string; cause?: { code?: string }; message?: string };
  return e?.name === "AbortError" || e?.name === "TimeoutError" || Boolean(e?.cause?.code) || /fetch failed|ECONNREFUSED|ENOTFOUND/.test(e?.message ?? "");
}

/** Text cut off by a length limit ends mid-sentence; trim it back to the last complete sentence. */
export function trimToSentence(text: string, limit: number): string {
  const t = text.trim();
  if (t.length < limit - 5 || /[.!?)`"']$/.test(t)) return t;
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  return end > t.length / 3 ? t.slice(0, end + 1) : `${t}…`;
}

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
