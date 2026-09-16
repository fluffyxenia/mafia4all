import type { NightActionType } from "./roles.js";
import type { ChannelId, PlayerId } from "./channels.js";
import type { DeathCause, Phase, VoteTarget } from "./state.js";

export type Command =
  | { type: "start_game" }
  | {
      type: "send_chat";
      playerId: PlayerId;
      channel: ChannelId;
      message: string;
      replyToPingId?: string;
    }
  | { type: "ping_player"; playerId: PlayerId; targetPlayerId: PlayerId; message: string }
  | { type: "cast_vote"; playerId: PlayerId; target: VoteTarget; reasoning?: string }
  | {
      type: "night_action";
      playerId: PlayerId;
      actionType: NightActionType;
      targetPlayerId?: PlayerId;
      reasoning?: string;
    }
  | { type: "jester_revenge"; playerId: PlayerId; targetPlayerId: PlayerId; reasoning?: string }
  | { type: "pass"; playerId: PlayerId };

export type GameEvent =
  | { type: "game_started" }
  | { type: "phase_changed"; from: Phase; to: Phase; day: number }
  | { type: "chat_sent"; channel: ChannelId; authorId: PlayerId; messageId: string }
  | { type: "vote_cast"; playerId: PlayerId; target: VoteTarget }
  | { type: "night_action_submitted"; playerId: PlayerId; actionType: NightActionType }
  | { type: "night_action_blocked"; playerId: PlayerId; actionType: NightActionType }
  | { type: "player_died"; playerId: PlayerId; cause: DeathCause; day: number }
  | { type: "request_more_messages_granted"; day: number }
  | { type: "draw_out_incremented"; count: number }
  | { type: "draw_out_reset" }
  | {
      type: "game_over";
      result: "town" | "mafia" | "serial_killer" | "jester" | "tanner" | "draw_out";
      winningPlayerIds: PlayerId[];
    };

export type CommandResult =
  | { ok: true; state: import("./state.js").GameState; events: GameEvent[] }
  | { ok: false; state: import("./state.js").GameState; error: string };
