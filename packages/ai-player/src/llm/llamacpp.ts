import { completeOpenAiCompatible, createTimeoutDispatcher, type OpenAiCompatibleConfig } from "./openai-compatible.js";
import type { LlmAdapter, LlmCompleteRequest, LlmCompleteResult } from "./types.js";

export interface LlamaCppAdapterOptions {
  /** Base URL of a running `llama-server` instance, e.g. http://localhost:8080/v1 */
  baseUrl?: string;
  /** llama.cpp's OpenAI-compatible endpoint ignores this but requires the field present. */
  model?: string;
  /** How long to wait for the model to respond, in ms. See DEFAULT_LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Hard cap on generated tokens per request. See DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /**
   * Forces `chat_template_kwargs: { enable_thinking }` on every request —
   * needed for Qwen3-family Jinja templates (e.g. SmolLM3's) whose own
   * default is to reason in a `<think>` block unless told otherwise. Leave
   * unset for a model/template with no such kwarg (it's simply ignored).
   */
  enableThinking?: boolean;
  fetchImpl?: OpenAiCompatibleConfig["fetchImpl"];
}

export class LlamaCppAdapter implements LlmAdapter {
  private config: OpenAiCompatibleConfig;
  private readonly timeoutMs: number | undefined;

  constructor(options: LlamaCppAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs;
    this.config = {
      baseUrl: options.baseUrl ?? "http://localhost:8080/v1",
      model: options.model ?? "local",
      fetchImpl: options.fetchImpl,
      dispatcher: createTimeoutDispatcher(options.timeoutMs),
      maxTokens: options.maxTokens,
      ...(options.enableThinking !== undefined
        ? { extraBody: { chat_template_kwargs: { enable_thinking: options.enableThinking } } }
        : {}),
    };
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    try {
      return await completeOpenAiCompatible(this.config, request);
    } catch (err) {
      // undici's Agent can leave a pooled socket in a bad state after a
      // timed-out/aborted request — suspected in real testing (a retry
      // right after a HeadersTimeoutError hung again with the same
      // symptom). Swap in a fresh dispatcher so the *next* call never
      // reuses a connection that just failed; best-effort teardown of the
      // stale one, since it's already broken and shouldn't block recovery.
      const stale = this.config.dispatcher;
      this.config.dispatcher = createTimeoutDispatcher(this.timeoutMs);
      void stale?.destroy().catch(() => {});
      throw err;
    }
  }
}
