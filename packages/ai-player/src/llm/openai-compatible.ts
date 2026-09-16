import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { LlmCompleteRequest, LlmCompleteResult, LlmMessage } from "./types.js";

/**
 * Free-tier/hosted APIs can also queue a request behind rate limits for a
 * while, and local CPU-only inference can legitimately take a long time per
 * turn. This used to default to 20 minutes, back when nothing bounded how
 * long a response could run — but every request now sets an explicit
 * max_tokens (see DEFAULT_MAX_TOKENS below), which caps legitimate
 * worst-case generation time to single-digit minutes even on the slowest,
 * most thread-limited hardware in real testing (~2.2 tok/s observed). A
 * 20-minute timeout past that point isn't buying legitimate slow inference
 * anything — it's just how long a genuinely stuck connection (e.g. a
 * silently dropped socket, observed twice in real testing: the request
 * shows nothing in-flight server-side, yet the client sits there awaiting a
 * response that will never arrive) sits unnoticed before AgentLoop's normal
 * retry-on-failure path can even kick in. 8 minutes keeps a solid ~2x
 * margin over the worst observed legitimate generation time while cutting
 * stuck-connection recovery time by more than half. Override for a faster
 * setup if you want quicker failure on a truly stuck server.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * Every request sets an explicit max_tokens — without one, llama-server (and
 * presumably other backends) defaults to n_predict/max_tokens: -1, uncapped
 * generation bounded only by context size. A model that's borderline on
 * tool-calling reliability can ramble indefinitely with no natural stop
 * token, observed in real testing as a small local model generating
 * continuously for 5+ minutes with no end in sight. 1024 is generous enough
 * to cover a real `<think>` block plus reasoning plus the tool call itself
 * (cutting a response off mid-think, before the tool call is emitted, would
 * produce the exact "finish_reason: length, no tool_calls" failure this is
 * meant to prevent) while still bounding worst-case latency to a few
 * minutes even on the slowest hardware in the roster.
 */
export const DEFAULT_MAX_TOKENS = 1024;

/** One Agent per adapter instance, reused across calls for connection pooling. */
export function createTimeoutDispatcher(timeoutMs: number = DEFAULT_LLM_TIMEOUT_MS): Dispatcher {
  return new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: timeoutMs });
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Injectable for testing; defaults to undici's fetch (so `dispatcher` below is honored). */
  fetchImpl?: typeof fetch;
  extraHeaders?: Record<string, string>;
  /**
   * Controls how long to wait for headers/body from the model before
   * giving up. Local CPU-only inference on modest hardware can legitimately
   * take several minutes for a single turn (especially with a handful of
   * tool schemas in the prompt) — Node's default undici headers timeout
   * (5 minutes) is too short for that and was hit in real testing, so this
   * defaults much higher. Construct once per adapter instance and reuse
   * across calls for connection pooling; omit for the global default.
   */
  dispatcher?: Dispatcher;
  /** Hard cap on generated tokens per request. See DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /**
   * Merged directly into the request body. Exists for backend-specific
   * knobs outside the standard OpenAI request shape — e.g. llama.cpp's
   * `chat_template_kwargs: { enable_thinking: false }`, needed to keep a
   * Jinja template's own reasoning-mode default (often "on") from
   * reintroducing a slow, unreliable `<think>` block. See LlamaCppAdapter's
   * `enableThinking` option, found necessary in real testing: SmolLM3 with
   * thinking left on only converged to a real tool call 7/10 times
   * (69-209s, two reps ran out the full token budget with nothing to show
   * for it), vs. clean and fast every time with it off.
   */
  extraBody?: Record<string, unknown>;
}

function toWireMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }
        : {}),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: "user", content: m.content };
}

/** Pure: builds the JSON body for an OpenAI-compatible /chat/completions request. */
export function buildRequestBody(
  config: { model: string; maxTokens?: number; extraBody?: Record<string, unknown> },
  request: LlmCompleteRequest,
): Record<string, unknown> {
  return {
    model: config.model,
    messages: [{ role: "system", content: request.systemPrompt }, ...request.messages.map(toWireMessage)],
    tools: request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...config.extraBody,
  };
}

/**
 * Scans `text` starting at an opening `{` for its matching `}`, respecting
 * quoted strings (so braces inside a string value don't throw off the
 * count). Returns the balanced `{...}` substring, or undefined if it never
 * closes.
 */
function findBalancedJsonObject(text: string, startIndex: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return undefined;
}

/**
 * Some models are genuinely trained on real tool-calling but express it as a
 * literal `{"name": ..., "arguments": {...}}` blob in plain text content —
 * optionally wrapped in `<tool_call>...</tool_call>` tags, per SmolLM3's own
 * documented "xml_tools" convention — rather than populating the OpenAI
 * `tool_calls` field. Found in real testing: this happens even with the
 * model's own correct chat template loaded, because llama.cpp's server only
 * parses `<tool_call>` output into `tool_calls` when it recognizes the
 * template as one of a handful of known conventions (its detector requires
 * `<tool_call>` + `<function=` + `<parameter=` together, the Qwen3-Coder
 * shape) — a template using the plain-JSON-in-<tool_call> convention instead
 * gets permanently classified `chat_format: Content-only` for the whole
 * server session, regardless of what the model actually emits. The model's
 * intent is still real and unambiguous (our actual tool name, our actual
 * argument keys) — this recovers it instead of discarding it as plain text.
 * Deliberately strict (requires both a string `name` and an object
 * `arguments` key) so ordinary prose that happens to contain a JSON-looking
 * fragment isn't misread as a tool call.
 */
function extractInlineToolCall(content: string | undefined): { name: string; arguments: Record<string, unknown> } | undefined {
  if (!content) return undefined;
  const tagMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  const searchText = tagMatch?.[1] ?? content;
  const start = searchText.indexOf("{");
  if (start === -1) return undefined;
  const jsonText = findBalancedJsonObject(searchText, start);
  if (!jsonText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  const candidate = parsed as { name?: unknown; arguments?: unknown };
  if (typeof candidate.name === "string" && typeof candidate.arguments === "object" && candidate.arguments !== null) {
    return { name: candidate.name, arguments: candidate.arguments as Record<string, unknown> };
  }
  return undefined;
}

/** Pure: extracts a tool call or plain text reply from an OpenAI-shaped response body. */
export function parseResponseBody(body: unknown): LlmCompleteResult {
  const choice = (body as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: string; tool_calls?: unknown[]; reasoning?: string; reasoning_content?: string } }
    | undefined;
  const message = choice?.message;
  const rawCall = message?.tool_calls?.[0] as
    | { id?: string; function?: { name?: string; arguments?: string } }
    | undefined;
  // llama.cpp and OpenRouter both surface this as message.reasoning in real
  // testing; message.reasoning_content is a fallback seen on some other
  // OpenAI-compatible backends/proxies (e.g. DeepSeek-style APIs).
  const reasoning = message?.reasoning || message?.reasoning_content || undefined;

  const rawUsage = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })
    ?.usage;
  const usage =
    rawUsage && typeof rawUsage.prompt_tokens === "number" && typeof rawUsage.completion_tokens === "number"
      ? {
          promptTokens: rawUsage.prompt_tokens,
          completionTokens: rawUsage.completion_tokens,
          totalTokens: rawUsage.total_tokens ?? rawUsage.prompt_tokens + rawUsage.completion_tokens,
        }
      : undefined;

  if (rawCall?.function?.name) {
    let args: Record<string, unknown> = {};
    try {
      args = rawCall.function.arguments ? JSON.parse(rawCall.function.arguments) : {};
    } catch {
      args = {};
    }
    return {
      toolCall: { id: rawCall.id ?? "call_0", name: rawCall.function.name, arguments: args },
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  const inline = extractInlineToolCall(message?.content);
  if (inline) {
    return {
      toolCall: { id: "call_0", name: inline.name, arguments: inline.arguments },
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  return { text: message?.content ?? "", ...(reasoning ? { reasoning } : {}), ...(usage ? { usage } : {}) };
}

export async function completeOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  request: LlmCompleteRequest,
): Promise<LlmCompleteResult> {
  const doFetch = config.fetchImpl ?? ((undiciFetch as unknown) as typeof fetch);
  const res = await doFetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.extraHeaders,
    },
    body: JSON.stringify(buildRequestBody(config, request)),
    ...(config.dispatcher ? ({ dispatcher: config.dispatcher } as Record<string, unknown>) : {}),
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`LLM request to ${config.baseUrl} failed: ${res.status} ${await res.text()}`);
  }
  return parseResponseBody(await res.json());
}
