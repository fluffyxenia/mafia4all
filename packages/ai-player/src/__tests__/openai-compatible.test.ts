import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_TOKENS, buildRequestBody, completeOpenAiCompatible, parseResponseBody } from "../llm/openai-compatible.js";
import type { LlmCompleteRequest } from "../llm/types.js";

const baseRequest: LlmCompleteRequest = {
  systemPrompt: "You are playing Mafia.",
  messages: [{ role: "user", content: "Day 1, phase: day_discussion." }],
  tools: [{ name: "pass", description: "end your turn", parameters: { type: "object", properties: {} } }],
};

describe("buildRequestBody", () => {
  it("puts the system prompt first and maps tools to OpenAI function-calling shape", () => {
    const body = buildRequestBody({ model: "test-model" }, baseRequest) as any;
    expect(body.model).toBe("test-model");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are playing Mafia." });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "pass", description: "end your turn", parameters: { type: "object", properties: {} } },
    });
  });

  it("serializes an assistant tool call and a following tool-result message", () => {
    const req: LlmCompleteRequest = {
      ...baseRequest,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "pass", arguments: {} }] },
        { role: "tool", content: "ok", toolCallId: "call_1" },
      ],
    };
    const body = buildRequestBody({ model: "m" }, req) as any;
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "pass", arguments: "{}" } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
  });

  it("always sets an explicit max_tokens, defaulting when none is configured", () => {
    // Regression: without this, llama-server defaults to n_predict: -1
    // (uncapped) — a borderline-coherent small model can then ramble
    // indefinitely with no natural stop token, observed in real testing as
    // continuous generation for 5+ minutes with no end in sight.
    const body = buildRequestBody({ model: "m" }, baseRequest) as any;
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);

    const overridden = buildRequestBody({ model: "m", maxTokens: 256 }, baseRequest) as any;
    expect(overridden.max_tokens).toBe(256);
  });
});

describe("parseResponseBody", () => {
  it("extracts a tool call with parsed arguments", () => {
    const result = parseResponseBody({
      choices: [
        {
          message: {
            tool_calls: [{ id: "call_9", function: { name: "cast_vote", arguments: '{"target":"p2"}' } }],
          },
        },
      ],
    });
    expect(result).toEqual({ toolCall: { id: "call_9", name: "cast_vote", arguments: { target: "p2" } } });
  });

  it("falls back to plain text when there's no tool call", () => {
    const result = parseResponseBody({ choices: [{ message: { content: "I'll wait and see." } }] });
    expect(result).toEqual({ text: "I'll wait and see." });
  });

  it("treats malformed tool-call arguments as an empty object instead of throwing", () => {
    const result = parseResponseBody({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "pass", arguments: "{not json" } }] } }],
    });
    expect(result.toolCall).toEqual({ id: "c1", name: "pass", arguments: {} });
  });

  it("captures message.reasoning alongside a tool call, for the turns log", () => {
    // Regression: this used to be discarded entirely at parse time, so even
    // an explicitly-enabled turns log never actually had a model's reasoning
    // in it — unrecoverable after the fact once a pivotal turn had passed.
    const result = parseResponseBody({
      choices: [
        {
          message: {
            reasoning: "Thinking it through...",
            tool_calls: [{ id: "c1", function: { name: "pass", arguments: "{}" } }],
          },
        },
      ],
    });
    expect(result.reasoning).toBe("Thinking it through...");
  });

  it("falls back to message.reasoning_content when reasoning is absent", () => {
    const result = parseResponseBody({
      choices: [{ message: { reasoning_content: "Alt field name.", content: "hi" } }],
    });
    expect(result.reasoning).toBe("Alt field name.");
  });

  it("omits reasoning entirely when the backend doesn't provide one", () => {
    const result = parseResponseBody({ choices: [{ message: { content: "hi" } }] });
    expect(result.reasoning).toBeUndefined();
  });

  it("recovers a bare {name, arguments} JSON blob left in plain content as a real tool call", () => {
    // Regression: found in real testing with SmolLM3 — a model genuinely
    // trained on native tool-calling (its own documented "xml_tools"
    // convention) still lands its call in plain `content` instead of
    // `tool_calls` whenever llama.cpp's server doesn't recognize the
    // model's own chat template as one of its known tool-call formats
    // (permanently `chat_format: Content-only` for the whole session in
    // that case, confirmed against llama.cpp's actual detector logic) —
    // the model's intent is still real (our exact tool name/argument
    // keys), so this recovers it instead of discarding it as an
    // incoherent non-tool-calling model.
    const result = parseResponseBody({
      choices: [{ message: { content: '\n\n{"name": "send_chat", "arguments": {"channel": "town", "message": "hi"}}' } }],
    });
    expect(result.toolCall).toEqual({
      id: "call_0",
      name: "send_chat",
      arguments: { channel: "town", message: "hi" },
    });
  });

  it("recovers the same JSON blob when wrapped in <tool_call> tags", () => {
    const result = parseResponseBody({
      choices: [{ message: { content: '<tool_call>\n{"name": "pass", "arguments": {}}\n</tool_call>' } }],
    });
    expect(result.toolCall).toEqual({ id: "call_0", name: "pass", arguments: {} });
  });

  it("captures token usage alongside a tool call, for computing real per-model cost later", () => {
    // Added specifically to answer "how much would this game have cost on
    // a paid model" without guessing — per-MTok pricing varies by two to
    // three orders of magnitude across OpenRouter models, so an accurate
    // prompt/completion split genuinely matters here, not just a rough
    // token count.
    const result = parseResponseBody({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "pass", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 1500, completion_tokens: 230, total_tokens: 1730 },
    });
    expect(result.usage).toEqual({ promptTokens: 1500, completionTokens: 230, totalTokens: 1730 });
  });

  it("derives totalTokens when the backend omits it", () => {
    const result = parseResponseBody({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it("omits usage entirely when the backend doesn't provide it", () => {
    const result = parseResponseBody({ choices: [{ message: { content: "hi" } }] });
    expect(result.usage).toBeUndefined();
  });

  it("does not misread ordinary prose containing JSON-like text as a tool call", () => {
    // Guards against false positives: only a JSON object with both a
    // string `name` and an object `arguments` key counts.
    const result = parseResponseBody({
      choices: [{ message: { content: 'I think {p3} is suspicious, not a real tool call at all.' } }],
    });
    expect(result.toolCall).toBeUndefined();
    expect(result.text).toContain("suspicious");
  });
});

describe("completeOpenAiCompatible", () => {
  it("posts to <baseUrl>/chat/completions with an auth header when an apiKey is given", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const result = await completeOpenAiCompatible(
      { baseUrl: "https://example.test/v1/", apiKey: "secret", model: "m", fetchImpl },
      baseRequest,
    );

    expect(result).toEqual({ text: "hi" });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("throws with the response body on a non-ok HTTP status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      completeOpenAiCompatible({ baseUrl: "https://example.test/v1", model: "m", fetchImpl }, baseRequest),
    ).rejects.toThrow(/429/);
  });
});
