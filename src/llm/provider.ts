import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LlmConfig } from "../config.js";

/** Build a LangChain chat model for the configured provider. Providers are imported lazily so unused SDKs never load. */
export async function getChatModel(cfg: LlmConfig): Promise<BaseChatModel> {
  switch (cfg.provider) {
    case "ollama": {
      const { ChatOllama } = await import("@langchain/ollama");
      return new ChatOllama({
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "http://localhost:11434",
        temperature: 0,
        // Ollama's default context (2-4k tokens) silently truncates plans; much larger
        // contexts reserve KV-cache VRAM and can OOM consumer GPUs.
        numCtx: cfg.numCtx,
      });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({ model: cfg.model, temperature: 0, maxTokens: 8192, maxRetries: 2 });
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({ model: cfg.model, maxRetries: 2 });
    }
  }
}
