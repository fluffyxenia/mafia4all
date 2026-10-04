import { completeOpenAiCompatible, createTimeoutDispatcher, type OpenAiCompatibleConfig } from "./openai-compatible.js";
import type { LlmAdapter, LlmCompleteRequest, LlmCompleteResult, LlmToolSpec } from "./types.js";

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
  /**
   * When true, never sends the native OpenAI `tools`/`tool_choice` fields —
   * instead describes the currently-available tools as plain text appended
   * to the message content, relying on openai-compatible.ts's
   * extractInlineToolCall to recover a `<tool_call>{...}</tool_call>` (or
   * bare JSON) reply the same way the existing crutch-example mechanism
   * already does.
   *
   * Why this exists: a dynamic `tools` array (tool-availability.ts narrows
   * it every turn — different action types, different writable channels)
   * gets rendered by llama.cpp's chat template into a preamble placed near
   * the very start of the actual prompt. Prefix-based KV-cache matching is
   * all-or-nothing from the first divergent token, so a changing preamble
   * at position 0 means nothing downstream — not even a byte-identical
   * system prompt or transcript — ever gets reused. Confirmed live on two
   * local seats (Boonie, Gemma 4): a "no cache hit after only 4 messages"
   * symptom, and a real server log showing 280+ seconds of prompt
   * reprocessing on every single turn at only ~50% of context used (see
   * project memory). Moving the tool description into the message content
   * instead leaves the preamble-affecting part of the request empty/stable,
   * so only the genuinely-growing tail of the prompt needs reprocessing.
   *
   * Trade-off (why this isn't just always on): loses llama.cpp's
   * grammar-enforced (GBNF) structured tool-call output — the model has to
   * choose to emit the right shape rather than being mechanically forced
   * into it, same category of risk already accepted once for Boonie and
   * explicitly declined at the time. Opt-in per seat until proven not to
   * regress reliability.
   */
  textToolCalling?: boolean;
  fetchImpl?: OpenAiCompatibleConfig["fetchImpl"];
}

/**
 * Plain-text description of every currently-offered tool plus the exact
 * reply shape expected back — the same `<tool_call>{...}</tool_call>`
 * convention extractInlineToolCall already recovers (see
 * mafia4all-tool-call-crutch-validated: this shape was live-validated as
 * something models genuinely imitate correctly once shown it).
 */
function renderToolsAsText(tools: LlmToolSpec[]): string {
  const toolBlocks = tools.map(
    (t) => `- ${t.name}: ${t.description}\n  parameters (JSON Schema): ${JSON.stringify(t.parameters)}`,
  );
  return [
    "Available actions this turn — choose exactly one and reply with it in the exact shape shown below,",
    "nothing else:",
    "",
    ...toolBlocks,
    "",
    "Reply format (name must be one of the actions above; arguments must match that action's parameters):",
    "<tool_call>",
    '{"name": "<action name>", "arguments": {...}}',
    "</tool_call>",
  ].join("\n");
}

export class LlamaCppAdapter implements LlmAdapter {
  private config: OpenAiCompatibleConfig;
  private readonly timeoutMs: number | undefined;
  private readonly textToolCalling: boolean;

  constructor(options: LlamaCppAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs;
    this.textToolCalling = options.textToolCalling ?? false;
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
    const effectiveRequest =
      this.textToolCalling && request.tools.length > 0
        ? {
            ...request,
            messages: [...request.messages, { role: "user" as const, content: renderToolsAsText(request.tools) }],
            tools: [],
          }
        : request;
    try {
      return await completeOpenAiCompatible(this.config, effectiveRequest);
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
