export interface LlmToolSpec {
  name: string;
  description: string;
  /** Plain JSON Schema, taken verbatim from the MCP server's tools/list response. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface LlmCompleteRequest {
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
}

export interface LlmCompleteResult {
  /** Set when the model chose to call a tool. */
  toolCall?: LlmToolCall;
  /** Set when the model just replied with text (no tool call this turn). */
  text?: string;
  /**
   * The model's own chain-of-thought/reasoning trace, when the backend
   * returns one (llama.cpp's `reasoning`/`reasoning_content`, OpenRouter's
   * `reasoning`) — captured purely for the turns log; nothing in the game
   * loop depends on it. Previously discarded entirely at parse time, which
   * meant even an explicitly-enabled turns log never had it: a player's
   * reasoning right before a pivotal in-game moment was unrecoverable after
   * the fact.
   */
  reasoning?: string;
  /**
   * Token accounting from the backend's own `usage` field (standard on any
   * non-streaming OpenAI-compatible chat completion response, OpenRouter
   * included — no special request flag needed). Purely for the turns log:
   * nothing in the game loop depends on it. Added specifically so real
   * per-model cost can be computed after the fact (prompt vs. completion
   * tokens are priced very differently, and per-model $/MTok can vary by
   * two to three orders of magnitude on OpenRouter) instead of guessing
   * from a free-tier game before deciding whether a paid model is
   * affordable to add to the roster.
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** One backend a player's decision loop can be driven by. */
export interface LlmAdapter {
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResult>;
}
