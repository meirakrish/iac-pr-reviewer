import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LlmConfig } from "../config.js";

/**
 * Build a LangChain chat model for the configured provider. Providers are imported lazily so unused SDKs never load.
 */
export async function getChatModel(cfg: LlmConfig): Promise<BaseChatModel> {
  switch (cfg.provider) {
    case "ollama": {
      const { ChatOllama } = await import("@langchain/ollama");
      const baseUrl = cfg.baseUrl ?? "http://localhost:11434";
      return new ChatOllama({
        model: cfg.model,
        baseUrl,
        // Thinking models (Qwen3, ...) would reason at length before the JSON answer: slower, and it eats into
        // the output cap. Turn it off, but only for models that support it; others reject the option.
        think: (await ollamaCapabilities(baseUrl, cfg.model)).includes("thinking") ? false : undefined,
        temperature: 0,
        // Ollama's default context (2-4k tokens) silently truncates plans; much larger
        // contexts reserve KV-cache VRAM and can OOM consumer GPUs.
        numCtx: cfg.numCtx,
        // Backstop for runaway generations (small models sometimes write one string forever).
        numPredict: cfg.maxOutputTokens,
      });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({ model: cfg.model, temperature: 0, maxTokens: cfg.maxOutputTokens, maxRetries: 2 });
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({ model: cfg.model, maxRetries: 2 });
    }
  }
}

/** Ask Ollama what a model supports (e.g. "completion", "tools", "thinking"). Empty if it can't be determined. */
export async function ollamaCapabilities(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { capabilities?: unknown };
    return Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [];
  } catch {
    // Server unreachable: the review call itself will report the real error.
    return [];
  }
}
