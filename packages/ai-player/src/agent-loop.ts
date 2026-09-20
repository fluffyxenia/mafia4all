import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildSystemPrompt } from "./prompts.js";
import { describeTurn, shouldPrompt } from "./describe-state.js";
import type { LlmAdapter, LlmCompleteResult, LlmMessage, LlmToolSpec } from "./llm/types.js";
import type { PlayerView } from "./view-types.js";

const VIEW_URI = "mafia://me/view";

/**
 * After this many consecutive failed turn attempts for the same turn
 * opportunity (provider error, a real tool call the engine rejected, or the
 * model responding with plain prose and no tool call at all), stop asking
 * the LLM and force a deterministic fallback action instead — see
 * chooseFallbackAction. Found in real testing: a genuinely broken/dead
 * endpoint or a persistently non-tool-calling model can otherwise block
 * every other player indefinitely, since day_discussion/day_vote turns are
 * strictly sequential.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

type FailureKind = "provider_error" | "tool_call_failure";

/**
 * The fallback message is deliberately blunt/system-flavored rather than
 * in-character ("I can't speak right now because...") — a natural-sounding
 * excuse would read as the model successfully talking its way around its
 * own failure, which is exactly the failure mode (a response with no real
 * tool call) this exists to stop treating as acceptable. Distinct wording
 * per failure kind mirrors what actually happened rather than a single
 * generic message.
 */
function fallbackChatMessage(kind: FailureKind): string {
  return kind === "provider_error" ? "error: API failure" : "error: tool-call failed";
}

function fallbackVoteReasoning(kind: FailureKind): string {
  return kind === "provider_error" ? "I had an API error, so I abstained." : "I failed to tool-call, so I abstained.";
}

/**
 * Picks the safest available action to force once MAX_CONSECUTIVE_FAILURES
 * is hit, from whichever tools are actually offered right now: a
 * day_discussion/mafia/deep_divers/lovers chat turn gets a blunt error
 * message on that channel (send_chat is the only way to advance that turn
 * queue — day_discussion has no `pass`); a day_vote turn gets a legal
 * `abstain` vote; a night action or Jester revenge (both of which offer a
 * real `pass`) gets a silent pass, since neither blocks any other player
 * the way a stuck chat/vote turn does. Reads the currently-allowed channel
 * straight off send_chat's own narrowed schema (see tool-availability.ts)
 * rather than re-deriving turn-channel logic here.
 */
function chooseFallbackAction(tools: LlmToolSpec[], kind: FailureKind): { name: string; arguments: Record<string, unknown> } | undefined {
  const sendChat = tools.find((t) => t.name === "send_chat");
  if (sendChat) {
    const channelSchema = (sendChat.parameters as { properties?: { channel?: { enum?: string[] } } }).properties?.channel;
    const allowed = channelSchema?.enum ?? [];
    const channel = allowed.includes("town") ? "town" : allowed[0];
    if (channel) return { name: "send_chat", arguments: { channel, message: fallbackChatMessage(kind) } };
  }
  if (tools.some((t) => t.name === "cast_vote")) {
    return { name: "cast_vote", arguments: { target: "abstain", reasoning: fallbackVoteReasoning(kind) } };
  }
  if (tools.some((t) => t.name === "pass")) {
    return { name: "pass", arguments: {} };
  }
  return undefined;
}

/**
 * Wraps a tool-call example as a fenced block matching the exact shape
 * extractInlineToolCall (see openai-compatible.ts) recovers, whether or not
 * the backend actually supports real structured tool_calls — the same
 * `<tool_call>{...}</tool_call>` convention documented there.
 */
function exampleBlock(name: string, args: Record<string, unknown>): string {
  return [
    "Reminder: you must respond by calling exactly one real tool — not by writing prose that merely",
    "describes or resembles one. Here is a worked example of the exact JSON shape a valid tool call",
    "takes (this is only to show the shape — the key names, quoting, and nesting — not something to",
    "copy). Call the real tool with your own actual decision instead:",
    "<tool_call>",
    JSON.stringify({ name, arguments: args }),
    "</tool_call>",
  ].join("\n");
}

/**
 * Builds one concrete, correctly-shaped tool-call example from whichever
 * real tool is actually offered this turn — live-validated fix (see project
 * memory: pasting exactly this shape directly into a stuck game unstuck a
 * model that had been producing plain prose instead of a tool call). The
 * theory: some models fail to call tools not from a capability gap but a
 * formatting/grounding gap — they need one worked example of the exact call
 * shape to imitate. Built from the real schema actually offered (not a
 * fixed template) so the example is never itself invalid for this turn —
 * e.g. a send_chat example always names a channel this player can genuinely
 * post to right now. Only called once a model has already failed to
 * produce a tool call this turn opportunity (see MAX_CONSECUTIVE_FAILURES),
 * so this never pads a first, unproblematic attempt.
 */
function buildCrutchExample(tools: LlmToolSpec[]): string | undefined {
  const enumOf = (tool: LlmToolSpec, prop: string): string[] =>
    (tool.parameters as { properties?: Record<string, { enum?: string[] }> }).properties?.[prop]?.enum ?? [];

  const sendChat = tools.find((t) => t.name === "send_chat");
  if (sendChat) {
    const channels = enumOf(sendChat, "channel");
    const channel = channels.includes("town") ? "town" : channels[0];
    if (channel) return exampleBlock("send_chat", { channel, message: "<replace with your real message>" });
  }

  if (tools.some((t) => t.name === "cast_vote")) {
    return exampleBlock("cast_vote", { target: "abstain", reasoning: "<replace with your real reasoning>" });
  }

  const nightAction = tools.find((t) => t.name === "night_action");
  if (nightAction) {
    const actionType = enumOf(nightAction, "actionType")[0];
    if (actionType) {
      return exampleBlock("night_action", {
        actionType,
        targetPlayerId: "<a real player id from the roster, or omit this field for an action with no target>",
      });
    }
  }

  if (tools.some((t) => t.name === "ping_player")) {
    return exampleBlock("ping_player", {
      targetPlayerId: "<a real player id from the roster>",
      message: "<replace with your real message>",
    });
  }

  if (tools.some((t) => t.name === "jester_revenge")) {
    return exampleBlock("jester_revenge", { targetPlayerId: "<a real player id from the roster>" });
  }

  if (tools.some((t) => t.name === "pass")) {
    return exampleBlock("pass", {});
  }

  return undefined;
}

/**
 * One LLM decision point, captured with everything needed to replay it as a
 * training example: the exact input (system prompt, message history, tool
 * schema offered) paired with the exact output (tool call or free text).
 * Deliberately independent of GameRuntime's transcript persistence, which
 * snapshots final GameState for crash recovery, not per-turn model I/O.
 */
export interface TurnRecord {
  playerId: string;
  phase: string;
  dayNumber: number;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  result: LlmCompleteResult;
}

export interface AgentLoopOptions {
  client: Client;
  llm: LlmAdapter;
  /** How often to poll for new activity. */
  pollIntervalMs?: number;
  /** Force a turn at least this often even with no new activity (so a player who still needs to act, e.g. vote, isn't stuck silent). */
  idleNudgeMs?: number;
  onLog?: (line: string) => void;
  /** Fired once per successful LLM decision — see TurnRecord. Not called when the LLM request itself fails. */
  onTurn?: (record: TurnRecord) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives one AI player: read the current view -> decide whether anything's
 * worth reacting to -> ask the LLM -> invoke whichever tool it chose (or
 * none, if it just wants to think out loud) -> repeat. This is the
 * reference implementation proving the MCP player interface is sufficient
 * for a fully automated player — the same seam future integrations
 * (openclaw, ggmlagent) would use.
 */
export class AgentLoop {
  private lastView: PlayerView | undefined;
  private lastPromptedAt = 0;
  private stopped = true;
  /** Reset on any successful action (or phase/day change) — see MAX_CONSECUTIVE_FAILURES. */
  private consecutiveFailures = 0;
  /**
   * Which kind the *last* failure was, so the tool-call-example crutch
   * (see buildCrutchExample) only kicks in for a formatting/grounding
   * failure (no real tool call produced) — a provider_error (timeout,
   * network failure, etc.) isn't a formatting problem, and padding the
   * prompt with an example does nothing for a dead/slow endpoint. Reset
   * alongside consecutiveFailures.
   */
  private lastFailureKind: FailureKind | undefined;

  constructor(private opts: AgentLoopOptions) {}

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  private async fetchView(): Promise<PlayerView> {
    const result = await this.opts.client.readResource({ uri: VIEW_URI });
    const first = result.contents[0] as { text: string };
    return JSON.parse(first.text) as PlayerView;
  }

  private async listTools(): Promise<LlmToolSpec[]> {
    const result = await this.opts.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }

  private async takeTurn(view: PlayerView, tools: LlmToolSpec[]): Promise<void> {
    const systemPrompt = buildSystemPrompt(view);
    // A single, stateless user message carrying the full current game state
    // (including the complete chat transcript — see describeTurn) rather
    // than an accumulated multi-turn conversation. This fixes two real bugs
    // found in live testing at once: (1) a player's own past no-tool-call
    // replies used to get pushed back into their own future context,
    // letting a single bad turn poison every turn after it into a
    // self-reinforcing repetition loop; (2) since describeTurn now embeds
    // the full transcript every turn anyway, an accumulated history would
    // just duplicate it turn after turn for no benefit. Each turn is
    // computed fresh from the current PlayerView instead.
    const messages: LlmMessage[] = [{ role: "user", content: describeTurn(this.lastView, view) }];
    if (this.consecutiveFailures > 0 && this.lastFailureKind === "tool_call_failure") {
      const crutch = buildCrutchExample(tools);
      if (crutch) messages.push({ role: "user", content: crutch });
    }

    let result: Awaited<ReturnType<typeof this.opts.llm.complete>>;
    try {
      result = await this.opts.llm.complete({ systemPrompt, messages, tools });
    } catch (err) {
      // A single flaky/slow/unreachable LLM call (network error, timeout,
      // malformed response) must not take down the whole process — skip
      // this turn and try again on the next poll/idle-nudge tick.
      // A bare `String(err)` on a wrapped fetch failure (e.g. undici's
      // generic "TypeError: fetch failed") drops the actual underlying
      // cause (timeout, ECONNREFUSED, etc.), which is exactly what you need
      // to tell a slow-but-working local model apart from a truly broken
      // endpoint — surface it whenever present.
      const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
      this.log(`${view.playerId}: LLM request failed, skipping this turn: ${String(err)}${cause}`);
      await this.recordFailure(view, tools, "provider_error");
      return;
    }

    this.opts.onTurn?.({
      playerId: view.playerId,
      phase: view.phase,
      dayNumber: view.dayNumber,
      systemPrompt,
      messages,
      tools,
      result,
    });

    if (result.toolCall) {
      let resultText: string;
      let succeeded = false;
      try {
        const callResult = (await this.opts.client.callTool({
          name: result.toolCall.name,
          arguments: result.toolCall.arguments,
        })) as { isError?: boolean; content: { type: string; text: string }[] };
        resultText = callResult.content?.[0]?.text ?? "";
        this.log(
          `${view.playerId}: ${result.toolCall.name}(${JSON.stringify(result.toolCall.arguments)}) -> ${resultText}`,
        );
        if (!callResult.isError) succeeded = true;
      } catch (err) {
        resultText = `tool call threw: ${String(err)}`;
        this.log(`${view.playerId}: ${resultText}`);
      }
      if (succeeded) {
        this.consecutiveFailures = 0;
        this.lastFailureKind = undefined;
      } else {
        await this.recordFailure(view, tools, "tool_call_failure");
      }
    } else {
      this.log(`${view.playerId}: (no tool call) ${result.text ?? ""}`);
      await this.recordFailure(view, tools, "tool_call_failure");
    }
  }

  /**
   * Counts one failed turn attempt; once MAX_CONSECUTIVE_FAILURES is
   * reached, stops asking the LLM and forces a deterministic fallback
   * action instead — see chooseFallbackAction. The counter resets
   * unconditionally afterward regardless of whether the fallback itself
   * succeeded, so a (should-never-happen) failure in the fallback path
   * can't wedge this into firing every single tick from then on.
   */
  private async recordFailure(view: PlayerView, tools: LlmToolSpec[], kind: FailureKind): Promise<void> {
    this.consecutiveFailures += 1;
    this.lastFailureKind = kind;
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return;
    this.consecutiveFailures = 0;
    this.lastFailureKind = undefined;

    const fallback = chooseFallbackAction(tools, kind);
    if (!fallback) {
      this.log(
        `${view.playerId}: hit ${MAX_CONSECUTIVE_FAILURES} consecutive failures (${kind}) but no safe fallback tool is currently offered — will keep retrying.`,
      );
      return;
    }
    this.log(
      `${view.playerId}: ${MAX_CONSECUTIVE_FAILURES} consecutive failures (${kind}) — forcing fallback ${fallback.name}(${JSON.stringify(fallback.arguments)}) to keep the game moving.`,
    );
    try {
      const callResult = (await this.opts.client.callTool({
        name: fallback.name,
        arguments: fallback.arguments,
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      this.log(`${view.playerId}: fallback ${fallback.name} -> ${callResult.content?.[0]?.text ?? ""}`);
    } catch (err) {
      this.log(`${view.playerId}: fallback tool call threw: ${String(err)}`);
    }
  }

  /** Runs until the game reaches post_game or stop() is called. */
  async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      // Both of these are plain MCP requests over the transport, not LLM
      // calls — but a dropped connection or a server hiccup can fail them
      // exactly like it can fail an LLM call, and until this was guarded a
      // single failure here rejected run()'s promise with nothing to catch
      // it, taking down the whole ai-player process (observed in real
      // testing: a seat's process fully exiting after one bad request).
      // Same recovery shape as takeTurn's LLM-call guard: log and retry on
      // the next tick instead of propagating.
      let view: PlayerView;
      let tools: LlmToolSpec[];
      try {
        view = await this.fetchView();
        tools = await this.listTools();
      } catch (err) {
        this.log(`view/tools fetch failed, retrying: ${String(err)}`);
        await sleep(this.opts.pollIntervalMs ?? 3000);
        continue;
      }

      if (view.phase === "post_game") {
        this.log(`${view.playerId}: game over (${view.winner?.result ?? "unknown"}).`);
        return;
      }

      if (this.lastView && (this.lastView.phase !== view.phase || this.lastView.dayNumber !== view.dayNumber)) {
        this.consecutiveFailures = 0;
        this.lastFailureKind = undefined;
      }

      // If nothing is currently callable (e.g. the lobby before start_game,
      // or any phase where this role/turn has nothing to do), there is
      // nothing an LLM call could accomplish: skip it outright rather than
      // let the idle-nudge timer alone justify burning a slow/rate-limited
      // call for a guaranteed no-op response.
      //
      // `pass` alone doesn't count as "something to do": during
      // day_discussion it's the only tool left for a player whose turn
      // hasn't come up yet (send_chat/ping_player only appear once it's
      // genuinely their turn — see tool-availability.ts), and the reactive
      // "new chat" check in shouldPrompt already knows to ignore that case.
      // But the idle-nudge fallback below doesn't make that distinction —
      // left ungated, it would eventually fire purely on elapsed time and
      // risk the model reaching for the only tool it sees (pass), wrongly
      // giving up all its remaining turns for a day that hadn't reached it
      // yet. Requiring a real, non-pass tool closes that off without
      // touching pass's own (deliberately turn-independent) availability.
      const hasRealTool = tools.some((t) => t.name !== "pass");

      const now = Date.now();
      let latestView = view;
      if (
        hasRealTool &&
        shouldPrompt(this.lastView, view, now - this.lastPromptedAt, this.opts.idleNudgeMs ?? 30_000)
      ) {
        await this.takeTurn(view, tools);
        this.lastPromptedAt = now;
        // Our own action can change our own view (e.g. a solo role's
        // private-log echo of its own statement) — refetch so `lastView`
        // already reflects that, or the next tick would misread our own
        // action's side effect as fresh "new information" worth a re-prompt.
        // A failure here just falls back to the pre-turn `view`: next tick's
        // own guarded fetch will pick up the real state either way.
        try {
          latestView = await this.fetchView();
        } catch (err) {
          this.log(`post-turn view refetch failed, using pre-turn view: ${String(err)}`);
        }
      }

      this.lastView = latestView;
      if (this.stopped) return;
      await sleep(this.opts.pollIntervalMs ?? 3000);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
