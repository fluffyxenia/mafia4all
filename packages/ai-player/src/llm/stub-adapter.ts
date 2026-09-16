import type { LlmAdapter, LlmCompleteRequest, LlmCompleteResult } from "./types.js";

/**
 * A scripted, network-free LlmAdapter. Used by tests to drive the agent
 * loop deterministically, and usable as a zero-dependency local "bot" when
 * no real model is configured. Each call to `complete` pops the next
 * scripted result; once the script is exhausted it falls back to
 * `defaultResult` (a "pass" tool call, by default) so a loop never hangs
 * waiting on a stub with nothing left to say.
 */
export class ScriptedAdapter implements LlmAdapter {
  private queue: LlmCompleteResult[];
  readonly calls: LlmCompleteRequest[] = [];

  constructor(
    script: LlmCompleteResult[] = [],
    private defaultResult: LlmCompleteResult = { toolCall: { id: "call_default", name: "pass", arguments: {} } },
  ) {
    this.queue = [...script];
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    this.calls.push(request);
    return this.queue.shift() ?? this.defaultResult;
  }
}
