import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createLlmClient, describeLlmError, llmDisabled, meetsThreshold, type LlmClient } from "@meirakrish/llm-kit";
import type { ReviewConfig } from "./config.js";
import { changedResources, changeStats } from "./plan/load.js";
import { opaqueUpdates, trimPlan } from "./plan/trim.js";
import { detectMoves } from "./plan/moves.js";
import { changeKind, type TerraformPlan } from "./plan/types.js";
import { runPrechecks } from "./prechecks/index.js";
import { llmReview } from "./llm/review.js";
import { mergeReview } from "./report/merge.js";
import type { LlmReview, ReviewResult } from "./schema.js";

export interface ReviewOptions {
  /** Inject an LLM client (tests). Defaults to one built from config.llm. */
  llm?: LlmClient;
  /** Inject a LangChain chat model; llm-kit still adds validation and retries. */
  model?: BaseChatModel;
  log?: (msg: string) => void;
}

/** The full pipeline: prechecks → LLM → merge. Never throws because of the LLM; it degrades to prechecks only. */
export async function reviewPlan(
  plan: TerraformPlan,
  config: ReviewConfig,
  opts: ReviewOptions = {},
): Promise<ReviewResult> {
  const log = opts.log ?? (() => {});
  const changes = changedResources(plan);
  const stats = changeStats(changes, plan.resource_changes ?? []);
  const prechecks = runPrechecks(changes, {
    requiredTags: config.requiredTags,
    moves: detectMoves(plan.resource_changes ?? []),
  });
  log(`${changes.length} changed resources, ${prechecks.length} precheck findings`);

  let llm: LlmReview | null = null;
  let llmMeta: ReviewResult["llm"] = llmDisabled();

  if (config.llm) llmMeta = { provider: config.llm.provider, model: config.llm.model, ok: false, error: null };
  if (config.llm && changes.length === 0) log("no resource changes: skipping the LLM review");
  if (config.llm && changes.length > 0) {
    const started = Date.now();
    let client: LlmClient | undefined;
    try {
      client =
        opts.llm ??
        (await createLlmClient(config.llm, {
          model: opts.model,
          log,
          overflowHint: "raise LLM_NUM_CTX or lower IAC_REVIEW_MAX_PLAN_CHARS",
        }));
      const trimmed = trimPlan(changes, config.maxPlanChars);
      if (trimmed.omitted.length)
        log(`plan too large: ${trimmed.omitted.length} resources omitted from the LLM prompt`);
      log(`calling ${config.llm.provider}/${config.llm.model}...`);
      llm = await llmReview(client, { stats, prechecks, plan: trimmed });
      llmMeta.ok = true;
    } catch (err) {
      llmMeta.error = describeLlmError(err);
      log(`LLM review failed, continuing with prechecks only: ${llmMeta.error}`);
    }
    llmMeta.durationMs = Date.now() - started;
    if (client) llmMeta.usage = client.takeUsage();
  }

  return mergeReview({
    prechecks,
    llm,
    llmMeta,
    stats,
    actions: new Map(changes.map((c) => [c.address, changeKind(c.change.actions)])),
    opaque: opaqueUpdates(changes),
  });
}

export function exceedsThreshold(result: ReviewResult, failOn: ReviewConfig["failOn"]): boolean {
  return meetsThreshold(result.riskLevel, failOn);
}
