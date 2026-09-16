import { describe, expect, it } from "vitest";
import {
  OpenRouterAdapter,
  DEFAULT_OPENROUTER_MAX_TOKENS,
  DEFAULT_OPENROUTER_TIMEOUT_MS,
  DEFAULT_OPENROUTER_REASONING_EFFORT,
} from "../llm/openrouter.js";

describe("OpenRouterAdapter", () => {
  it("defaults max_tokens to DEFAULT_OPENROUTER_MAX_TOKENS, higher than llama.cpp's shared default", async () => {
    // Regression: a heavier/more variable reasoner (Nemotron 3.5 Lightning,
    // found in real testing) hit finish_reason: "length" at the old shared
    // 1024-token default one sentence before it would have emitted a real
    // tool call. OpenRouter is hosted inference with no local-hardware
    // latency budget to protect, so it gets its own, higher default.
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as Response;
    }) as typeof fetch;

    const adapter = new OpenRouterAdapter({ apiKey: "test-key", fetchImpl });
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(seenBody?.max_tokens).toBe(DEFAULT_OPENROUTER_MAX_TOKENS);
  });

  it("still honors an explicit maxTokens override", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as Response;
    }) as typeof fetch;

    const adapter = new OpenRouterAdapter({ apiKey: "test-key", fetchImpl, maxTokens: 512 });
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(seenBody?.max_tokens).toBe(512);
  });

  it("defaults its request timeout to DEFAULT_OPENROUTER_TIMEOUT_MS, far shorter than llama.cpp's shared 8-minute default", () => {
    // Regression: a silently hung OpenRouter connection (no error, just
    // never responding) sat for the full shared 8-minute default before
    // AgentLoop's own retry-on-failure path could even try again —
    // observed live as a "wedged for 5+ minutes" game stall that turned
    // out to be one stuck request, not a slow one. OpenRouter is hosted
    // inference with no legitimate case for an 8-minute wait.
    const adapter = new OpenRouterAdapter({ apiKey: "test-key" });
    expect((adapter as unknown as { timeoutMs: number }).timeoutMs).toBe(DEFAULT_OPENROUTER_TIMEOUT_MS);
  });

  it("still honors an explicit timeoutMs override", () => {
    const adapter = new OpenRouterAdapter({ apiKey: "test-key", timeoutMs: 30_000 });
    expect((adapter as unknown as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("defaults reasoning.effort to DEFAULT_OPENROUTER_REASONING_EFFORT, to control cost on paid reasoning models", async () => {
    // Added once paid seats entered the roster: output tokens are typically
    // priced several times higher than input on OpenRouter's paid models,
    // and a Mafia turn is a quick social read that doesn't benefit from a
    // long chain of thought — a reasoning model left at its own default
    // effort burns real money on thinking a fast game doesn't need.
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as Response;
    }) as typeof fetch;

    const adapter = new OpenRouterAdapter({ apiKey: "test-key", fetchImpl });
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(seenBody?.reasoning).toEqual({ effort: DEFAULT_OPENROUTER_REASONING_EFFORT });
  });

  it("still honors an explicit reasoningEffort override", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as Response;
    }) as typeof fetch;

    const adapter = new OpenRouterAdapter({ apiKey: "test-key", fetchImpl, reasoningEffort: "high" });
    await adapter.complete({ systemPrompt: "s", messages: [], tools: [] });

    expect(seenBody?.reasoning).toEqual({ effort: "high" });
  });
});
