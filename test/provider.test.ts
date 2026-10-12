import { describe, expect, it } from "vitest";
import { ollamaCapabilities } from "../src/llm/provider.js";

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe("ollamaCapabilities", () => {
  it("returns the model's capabilities", async () => {
    const caps = await ollamaCapabilities(
      "http://x:11434/",
      "qwen3:14b",
      respond(200, { capabilities: ["completion", "thinking"] }),
    );
    expect(caps).toEqual(["completion", "thinking"]);
  });

  it("returns nothing when the model is unknown or the server is down", async () => {
    expect(await ollamaCapabilities("http://x", "nope", respond(404, { error: "model not found" }))).toEqual([]);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await ollamaCapabilities("http://x", "m", down)).toEqual([]);
  });
});
