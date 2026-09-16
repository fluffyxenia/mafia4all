import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildPlayerView, buildSpectatorView } from "@mafia/engine";
import {
  CastVoteInput,
  JesterRevengeInput,
  NightActionInput,
  PingPlayerInput,
  ReasoningField,
  SendChatInput,
  type ChannelId,
  type Command,
  type CommandResult,
  type NightActionType,
  type PlayerId,
} from "@mafia/shared";
import type { GameRuntime } from "./runtime.js";
import { computeToolAvailability } from "./tool-availability.js";

function toToolResult(result: CommandResult) {
  if (!result.ok) {
    return { isError: true, content: [{ type: "text" as const, text: result.error }] };
  }
  return { content: [{ type: "text" as const, text: "ok" }] };
}

/**
 * Builds one MCP server instance bound to a single game+player. playerId is
 * fixed to the session (never taken from tool input) so a client can never
 * act as anyone but themselves. Tool visibility is a UX convenience only —
 * every handler routes through the same GameRuntime/engine command
 * validators that enforce phase, role, and turn-budget rules, so a
 * misbehaving client calling an inapplicable tool gets a clean rejection.
 */
export function createPlayerMcpServer(runtime: GameRuntime, gameId: string, playerId: PlayerId): McpServer {
  const server = new McpServer({ name: "mafia-for-all", version: "0.1.0" });

  const run = (command: Command) => toToolResult(runtime.applyPlayerCommand(gameId, command));

  const sendChatTool = server.registerTool(
    "send_chat",
    {
      title: "Send chat",
      description: "Send a message in one of your visible channels (town, mafia, deep_divers, or your lovers channel).",
      inputSchema: SendChatInput.shape,
    },
    async ({ channel, message, replyToPingId }) =>
      run({
        type: "send_chat",
        playerId,
        channel: channel as never,
        message,
        ...(replyToPingId ? { replyToPingId } : {}),
      }),
  );

  const pingPlayerTool = server.registerTool(
    "ping_player",
    {
      title: "Ping a player",
      description: "During day discussion, publicly ping another player; they get one free reply turn.",
      inputSchema: PingPlayerInput.shape,
    },
    async ({ targetPlayerId, message }) => run({ type: "ping_player", playerId, targetPlayerId, message }),
  );

  const castVoteTool = server.registerTool(
    "cast_vote",
    {
      title: "Cast day vote",
      description:
        'Vote for a player id to eliminate, "abstain", or "request_more_messages" (once per day). Your vote is cast openly — it and your reasoning are announced in town chat immediately.',
      inputSchema: CastVoteInput.shape,
    },
    async ({ target, reasoning }) =>
      run({ type: "cast_vote", playerId, target: target as never, ...(reasoning ? { reasoning } : {}) }),
  );

  const nightActionTool = server.registerTool(
    "night_action",
    {
      title: "Submit night action",
      description:
        "Submit your role's night action (only the action types your role allows will succeed). Mafia proposals and Deep Diver investigations are announced with your reasoning in your team channel; solo roles' reasoning is recorded to your own private log.",
      inputSchema: NightActionInput.shape,
    },
    async ({ actionType, targetPlayerId, reasoning }) =>
      run({
        type: "night_action",
        playerId,
        actionType,
        ...(targetPlayerId ? { targetPlayerId } : {}),
        ...(reasoning ? { reasoning } : {}),
      }),
  );

  const jesterRevengeTool = server.registerTool(
    "jester_revenge",
    {
      title: "Jester revenge kill",
      description: "Only usable by a just-voted-out Jester: eliminate one player who voted against you.",
      inputSchema: JesterRevengeInput.shape,
    },
    async ({ targetPlayerId, reasoning }) =>
      run({ type: "jester_revenge", playerId, targetPlayerId, ...(reasoning ? { reasoning } : {}) }),
  );

  const passTool = server.registerTool(
    "pass",
    {
      title: "Pass",
      description: "Voluntarily end your turn this phase (discussion), decline a night action, or decline revenge.",
      inputSchema: {},
    },
    async () => run({ type: "pass", playerId }),
  );

  /**
   * Narrows what's advertised to exactly what would actually succeed right
   * now (phase, and for night_action, role + remaining one-shot charges) —
   * see tool-availability.ts for why this matters for small/local models.
   * Subscribed to every state mutation for this game below, regardless of
   * which player's session caused it — a phase change caused by another
   * player's action must be reflected here immediately, not just the next
   * time this session happens to act or read its own view.
   */
  function refreshToolAvailability(): void {
    const availability = computeToolAvailability(runtime.getState(gameId), playerId);

    const { enabled: sendChatEnabled, allowedChannels } = availability.sendChat;
    sendChatTool.update({
      enabled: sendChatEnabled,
      ...(allowedChannels.length > 0
        ? {
            paramsSchema: {
              channel: z.enum(allowedChannels as [ChannelId, ...ChannelId[]]),
              message: z.string(),
              // .nullish(), not .optional() — see schemas.ts's SendChatInput
              // for why. This dynamic paramsSchema is the one actually live
              // once refreshToolAvailability runs (it overrides the static
              // SendChatInput.shape passed at registerTool time above), so
              // it needs the same fix independently.
              replyToPingId: z.string().nullish(),
            },
          }
        : {}),
    });
    const { enabled: pingEnabled, allowedTargets } = availability.pingPlayer;
    pingPlayerTool.update({
      enabled: pingEnabled,
      ...(allowedTargets.length > 0
        ? {
            paramsSchema: {
              targetPlayerId: z.enum(allowedTargets as [PlayerId, ...PlayerId[]]),
              message: z.string(),
            },
          }
        : {}),
    });
    castVoteTool.update({ enabled: availability.castVote });
    jesterRevengeTool.update({ enabled: availability.jesterRevenge });
    passTool.update({ enabled: availability.pass });

    const { enabled, allowedActionTypes } = availability.nightAction;
    nightActionTool.update({
      enabled,
      ...(allowedActionTypes.length > 0
        ? {
            paramsSchema: {
              actionType: z.enum(allowedActionTypes as [NightActionType, ...NightActionType[]]),
              // .nullish(), not .optional() — same reasoning as
              // replyToPingId above (this dynamic schema overrides
              // NightActionInput.shape's already-fixed field once this
              // runs).
              targetPlayerId: z.string().nullish(),
              reasoning: ReasoningField,
            },
          }
        : {}),
    });
  }
  refreshToolAvailability();
  const unsubscribe = runtime.onStateChange(gameId, refreshToolAvailability);
  server.server.onclose = () => unsubscribe();

  server.registerResource(
    "view",
    "mafia://me/view",
    {
      title: "Your view of the game",
      description: "Your role, the public roster, every channel you belong to, your private night log, and turn budgets.",
      mimeType: "application/json",
    },
    async (uri) => {
      const state = runtime.getState(gameId);
      const view = buildPlayerView(state, playerId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(view, null, 2) }] };
    },
  );

  return server;
}

/**
 * A read-only session for a host/stream audience: no tools at all (nothing
 * to act on), just the same `mafia://me/view` resource every player session
 * exposes, but returning buildSpectatorView's omniscient view instead.
 * Reusing the resource URI/shape means the existing player web client can
 * spectate a game with no client-side changes — just a different token.
 */
export function createSpectatorMcpServer(runtime: GameRuntime, gameId: string): McpServer {
  const server = new McpServer({ name: "mafia-for-all-spectator", version: "0.1.0" });

  // The SDK only wires up the tools/list + tools/call handlers the first
  // time registerTool is called — with genuinely zero tools ever
  // registered, tools/list errors as "Method not found" instead of
  // returning an empty list. Registering one and disabling it immediately
  // gets a real (empty) tool list with nothing actually callable.
  server.registerTool("spectate", { description: "No actions available — use the view resource." }, async () => ({
    content: [],
  })).disable();

  server.registerResource(
    "view",
    "mafia://me/view",
    {
      title: "Spectator view of the game",
      description: "Every role, every channel, and the full chat log, regardless of phase.",
      mimeType: "application/json",
    },
    async (uri) => {
      const view = buildSpectatorView(runtime.getState(gameId));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(view, null, 2) }] };
    },
  );

  return server;
}
