import { completeOpenAiCompatible, createTimeoutDispatcher, type OpenAiCompatibleConfig } from "./openai-compatible.js";
import type { LlmAdapter, LlmCompleteRequest, LlmCompleteResult } from "./types.js";

/**
 * A reasonable default free-tier model. OpenRouter's free-tier slugs
 * generally carry a `:free` suffix and rotate as providers change what's
 * available (Poolside, InclusionAI, etc.) — override via `model` or the
 * OPENROUTER_MODEL env var rather than relying on this staying current.
 */
export const DEFAULT_OPENROUTER_FREE_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

/**
 * OpenRouter gets a higher default than the shared DEFAULT_MAX_TOKENS
 * (1024, tuned against worst-case latency on the slowest local llama.cpp
 * seats) because none of that latency concern applies here — it's hosted
 * inference, not competing with a device's own CPU/GPU budget. Found to
 * matter in real testing: a heavier/more variable reasoner (Nemotron 3.5
 * Lightning) hit `finish_reason: "length"` at 1024 on a genuinely tool-
 * calling-capable turn, cut off one sentence before the tool call, then
 * converged cleanly once given more room.
 */
export const DEFAULT_OPENROUTER_MAX_TOKENS = 4096;

/**
 * OpenRouter gets a much shorter default than the shared
 * DEFAULT_LLM_TIMEOUT_MS (8 minutes, tuned for legitimately slow local
 * CPU-only inference) because that long a wait has no legitimate case here
 * — it's hosted inference behind a request/response API, not local compute
 * that might genuinely take minutes. Found in real testing: a silently
 * hung OpenRouter connection (no 429, no error — just never responding)
 * sat for the full 8 minutes before AgentLoop's own retry-on-failure path
 * could even try again, which is exactly the "wedged for 5+ minutes"
 * symptom that turned out to be a stuck request, not a legitimately slow
 * one. 2 minutes is still generous for a real (if heavy) reasoning turn
 * but cuts stuck-connection recovery time by a factor of 4.
 */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * OpenRouter's unified `reasoning.effort` request field ("minimal" | "low" |
 * "medium" | "high", exact supported set is model-dependent — unsupported
 * values/fields are ignored by models that don't have a reasoning mode at
 * all, same as llama.cpp silently ignoring chat_template_kwargs it doesn't
 * recognize). Defaults to the lowest tier: a Mafia turn is a quick social
 * read, not a problem that benefits from a long chain of thought, and
 * output tokens are typically priced several times higher than input on
 * paid models — exactly the dimension a heavy reasoner burns through
 * fastest. Keeping this low by default is real, direct cost control once
 * paid seats are in the roster, not just a latency tweak.
 */
export const DEFAULT_OPENROUTER_REASONING_EFFORT = "minimal";

export interface OpenRouterAdapterOptions {
  apiKey: string;
  model?: string;
  /** How long to wait for the model to respond, in ms. See DEFAULT_LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Hard cap on generated tokens per request. See DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** OpenRouter's reasoning-effort knob. See DEFAULT_OPENROUTER_REASONING_EFFORT. */
  reasoningEffort?: string;
  fetchImpl?: OpenAiCompatibleConfig["fetchImpl"];
}

export class OpenRouterAdapter implements LlmAdapter {
  private config: OpenAiCompatibleConfig;
  private readonly timeoutMs: number | undefined;

  constructor(options: OpenRouterAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
    this.config = {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_OPENROUTER_FREE_MODEL,
      fetchImpl: options.fetchImpl,
      dispatcher: createTimeoutDispatcher(this.timeoutMs),
      maxTokens: options.maxTokens ?? DEFAULT_OPENROUTER_MAX_TOKENS,
      extraBody: { reasoning: { effort: options.reasoningEffort ?? DEFAULT_OPENROUTER_REASONING_EFFORT } },
      // OpenRouter asks for these for attribution on free-tier usage; harmless if ignored.
      extraHeaders: { "HTTP-Referer": "https://github.com/mafia-for-all", "X-Title": "Mafia For All" },
    };
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    try {
      return await completeOpenAiCompatible(this.config, request);
    } catch (err) {
      // See LlamaCppAdapter's identical guard: undici's Agent can leave a
      // pooled socket in a bad state after a timed-out/aborted request, so
      // swap in a fresh dispatcher before the next call rather than risk
      // reusing a connection that just failed.
      const stale = this.config.dispatcher;
      this.config.dispatcher = createTimeoutDispatcher(this.timeoutMs);
      void stale?.destroy().catch(() => {});
      throw err;
    }
  }
}
