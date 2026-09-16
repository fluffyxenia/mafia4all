import { describe, expect, it } from "vitest";
import { LlamaCppAdapter } from "../llm/llamacpp.js";

describe("LlamaCppAdapter", () => {
  it("swaps in a fresh dispatcher after a failed request, instead of reusing one that just failed", async () => {
    const seenDispatchers: unknown[] = [];
    let call = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenDispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
      call += 1;
      // Simulates the real-world failure this guards against: undici
      // leaving a pooled connection in a bad state after e.g. a
      // HeadersTimeoutError, which a naive retry would reuse and hang on
      // again.
      if (call === 1) throw new Error("simulated undici HeadersTimeoutError");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "hi" } }] }),
      } as Response;
    }) as typeof fetch;

    const adapter = new LlamaCppAdapter({ fetchImpl });

    await expect(adapter.complete({ systemPrompt: "s", messages: [], tools: [] })).rejects.toThrow(
      "simulated undici HeadersTimeoutError",
    );
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(seenDispatchers).toHaveLength(2);
    expect(seenDispatchers[0]).toBeDefined();
    expect(seenDispatchers[1]).toBeDefined();
    expect(seenDispatchers[0]).not.toBe(seenDispatchers[1]);
  });

  it("sends chat_template_kwargs.enable_thinking when enableThinking is set", async () => {
    // Regression: SmolLM3's own Jinja template defaults to reasoning mode
    // on unless told otherwise, and thinking-on only converged to a real
    // tool call 7/10 times in real testing (69-209s, two reps burned the
    // full token budget with nothing to show for it) vs. clean and fast
    // every time with it off — this is the plumbing that lets a seat
    // actually turn it off.
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as Response;
    }) as typeof fetch;

    const adapter = new LlamaCppAdapter({ fetchImpl, enableThinking: false });
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(sentBody?.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("omits chat_template_kwargs entirely when enableThinking is left unset", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as Response;
    }) as typeof fetch;

    const adapter = new LlamaCppAdapter({ fetchImpl });
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(sentBody?.chat_template_kwargs).toBeUndefined();
  });
});
