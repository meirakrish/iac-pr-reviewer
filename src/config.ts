import {
  LLM_ENV,
  parseFailOn,
  resolveLlmConfig,
  type FailOn,
  type LlmConfig,
  type LlmConfigInput,
} from "@meirakrish/llm-kit";

export interface ReviewConfig {
  /** null disables the LLM step: prechecks only. */
  llm: LlmConfig | null;
  requiredTags: string[];
  /** Fail (non-zero exit / failed check) when riskLevel >= this. "none" never fails. */
  failOn: FailOn;
  /** Character budget for the plan excerpt sent to the LLM (~4 chars per token; must fit the model's context). */
  maxPlanChars: number;
}

export interface ConfigInput extends LlmConfigInput {
  noLlm?: boolean;
  requiredTags?: string;
  failOn?: string;
  maxPlanChars?: string | number;
}

type Env = Record<string, string | undefined>;

/**
 * Pre-llm-kit names of the shared LLM settings. Still read, with a deprecation warning, when the new name is
 * not set. Remove in 2.0.
 */
export const LEGACY_LLM_ENV: Record<string, string> = {
  IAC_REVIEW_PROVIDER: LLM_ENV.provider,
  IAC_REVIEW_MODEL: LLM_ENV.model,
  IAC_REVIEW_NUM_CTX: LLM_ENV.numCtx,
  IAC_REVIEW_MAX_OUTPUT_TOKENS: LLM_ENV.maxOutputTokens,
  IAC_REVIEW_TIMEOUT_MS: LLM_ENV.timeoutMs,
};

/**
 * Explicit input (CLI flags) wins over env vars, which win over defaults.
 * LLM settings use llm-kit's shared LLM_* variables; review settings use IAC_REVIEW_*.
 */
export function resolveConfig(
  input: ConfigInput = {},
  env: Env = process.env,
  warn: (msg: string) => void = (msg) => console.error(`[iac-review] ${msg}`),
): ReviewConfig {
  const failOn = parseFailOn(input.failOn ?? env.IAC_REVIEW_FAIL_ON ?? "none");
  const noLlm = input.noLlm ?? isTruthy(env.IAC_REVIEW_NO_LLM);
  return {
    llm: noLlm ? null : resolveLlmConfig(input, withLegacyEnv(env, warn)),
    requiredTags: splitList(input.requiredTags ?? env.IAC_REVIEW_REQUIRED_TAGS),
    failOn,
    maxPlanChars: Number(input.maxPlanChars ?? env.IAC_REVIEW_MAX_PLAN_CHARS ?? 40_000),
  };
}

function withLegacyEnv(env: Env, warn: (msg: string) => void): Env {
  const out = { ...env };
  for (const [legacy, current] of Object.entries(LEGACY_LLM_ENV)) {
    if (!env[legacy] || env[current]) continue;
    warn(`${legacy} is deprecated; use ${current}`);
    out[current] = env[legacy];
  }
  return out;
}

function splitList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes"].includes(v.toLowerCase());
}
