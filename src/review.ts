import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ReviewConfig } from "./config.js";
import { changedResources, changeStats } from "./plan/load.js";
import { opaqueUpdates, trimPlan } from "./plan/trim.js";
import { detectMoves } from "./plan/moves.js";
import { changeKind, type TerraformPlan } from "./plan/types.js";
import { runPrechecks } from "./prechecks/index.js";
import { getChatModel } from "./llm/provider.js";
import { llmReview } from "./llm/review.js";
import { mergeReview } from "./report/merge.js";
import { SEVERITY_ORDER, type LlmReview, type ReviewResult } from "./schema.js";

export interface ReviewOptions {
  /** Inject a chat model (tests, evals). Defaults to the one described by config.llm. */
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
  let llmMeta: ReviewResult["llm"] = { provider: "none", model: "none", ok: false, error: null };

  if (config.llm) llmMeta = { provider: config.llm.provider, model: config.llm.model, ok: false, error: null };
  if (config.llm && changes.length === 0) log("no resource changes: skipping the LLM review");
  if (config.llm && changes.length > 0) {
    try {
      const model = opts.model ?? (await getChatModel(config.llm));
      const trimmed = trimPlan(changes, config.maxPlanChars);
      if (trimmed.omitted.length)
        log(`plan too large: ${trimmed.omitted.length} resources omitted from the LLM prompt`);
      log(`calling ${config.llm.provider}/${config.llm.model}...`);
      llm = await llmReview(
        model,
        { stats, prechecks, plan: trimmed },
        {
          timeoutMs: config.llm.timeoutMs,
          log,
          boundedOutput: config.llm.provider === "ollama",
        },
      );
      llmMeta.ok = true;
    } catch (err) {
      llmMeta.error = describeError(err);
      log(`LLM review failed, continuing with prechecks only: ${llmMeta.error}`);
    }
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
  return failOn !== "none" && SEVERITY_ORDER[result.riskLevel] >= SEVERITY_ORDER[failOn];
}

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "request timed out";
  if (e?.cause?.code === "ECONNREFUSED") return "could not connect to the LLM server (is Ollama running?)";
  return (e?.message ?? String(err)).split("\n")[0]!.slice(0, 200);
}
