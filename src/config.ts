import { Severity } from "./schema.js";

export type Provider = "ollama" | "anthropic" | "openai";

export const DEFAULT_MODELS: Record<Provider, string> = {
  ollama: "qwen3.5:9b",
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5-mini",
};

export interface LlmConfig {
  provider: Provider;
  model: string;
  /** Ollama server URL; ignored by hosted providers. */
  baseUrl?: string;
  /** Ollama context window in tokens. */
  numCtx: number;
  /** Cap on generated tokens; stops runaway generations (a full review needs well under 2k). */
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ReviewConfig {
  /** null disables the LLM step: prechecks only. */
  llm: LlmConfig | null;
  requiredTags: string[];
  /** Fail (non-zero exit / failed check) when riskLevel >= this. "none" never fails. */
  failOn: Severity | "none";
  /** Character budget for the plan excerpt sent to the LLM (~4 chars per token; must fit the model's context). */
  maxPlanChars: number;
}

export interface ConfigInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  noLlm?: boolean;
  requiredTags?: string;
  failOn?: string;
  maxPlanChars?: string | number;
  timeoutMs?: string | number;
  numCtx?: string | number;
  maxOutputTokens?: string | number;
}

type Env = Record<string, string | undefined>;

/** Explicit input wins over IAC_REVIEW_* env vars, which win over defaults. */
export function resolveConfig(input: ConfigInput = {}, env: Env = process.env): ReviewConfig {
  const failOn = (input.failOn ?? env.IAC_REVIEW_FAIL_ON ?? "none").toLowerCase();
  if (failOn !== "none" && !Severity.safeParse(failOn).success) {
    throw new Error(`Invalid fail-on value "${failOn}". Use one of: none, ${Severity.options.join(", ")}.`);
  }

  const noLlm = input.noLlm ?? isTruthy(env.IAC_REVIEW_NO_LLM);
  return {
    llm: noLlm ? null : resolveLlm(input, env),
    requiredTags: splitList(input.requiredTags ?? env.IAC_REVIEW_REQUIRED_TAGS),
    failOn: failOn as Severity | "none",
    maxPlanChars: Number(input.maxPlanChars ?? env.IAC_REVIEW_MAX_PLAN_CHARS ?? 40_000),
  };
}

function resolveLlm(input: ConfigInput, env: Env): LlmConfig {
  const provider = (input.provider ?? env.IAC_REVIEW_PROVIDER ?? detectProvider(env)).toLowerCase();
  if (!(provider in DEFAULT_MODELS)) {
    throw new Error(`Unknown LLM provider "${provider}". Use one of: ${Object.keys(DEFAULT_MODELS).join(", ")}.`);
  }
  const p = provider as Provider;
  return {
    provider: p,
    model: input.model ?? env.IAC_REVIEW_MODEL ?? DEFAULT_MODELS[p],
    baseUrl: normalizeHost(input.baseUrl ?? env.OLLAMA_HOST),
    numCtx: Number(input.numCtx ?? env.IAC_REVIEW_NUM_CTX ?? 16_384),
    maxOutputTokens: Number(input.maxOutputTokens ?? env.IAC_REVIEW_MAX_OUTPUT_TOKENS ?? 4096),
    timeoutMs: Number(input.timeoutMs ?? env.IAC_REVIEW_TIMEOUT_MS ?? 180_000),
  };
}

/** Pick a hosted provider when its API key is present, otherwise fall back to local Ollama. */
function detectProvider(env: Env): Provider {
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

/** Ollama's own OLLAMA_HOST is often "host:port" without a scheme; HTTP clients need a full URL. */
function normalizeHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
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
