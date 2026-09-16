import { NARRATOR_ID, type ChannelId, type ChatMessage, type GameState, type Phase, type PlayerId } from "@mafia/shared";
import { nextMessageId } from "./ids.js";

/**
 * Appends a chat message as a side effect of game logic rather than a
 * player's own send_chat call — either a player's auto-generated statement
 * (mafia proposal, vote announcement) or a narrator-voiced announcement
 * (deaths, eliminations). Deliberately bypasses turn-budget accounting:
 * these are structural consequences of an action already taken, not a
 * discretionary chat turn.
 */
export function appendGeneratedMessage(
  state: GameState,
  entry: { channel: ChannelId; authorId: PlayerId; message: string; day: number; phase: Phase; system?: boolean },
): GameState {
  const msg: ChatMessage = {
    id: nextMessageId(),
    channel: entry.channel,
    authorId: entry.authorId,
    message: entry.message,
    day: entry.day,
    phase: entry.phase,
    ...(entry.system ? { system: true } : {}),
  };
  return { ...state, chatLog: [...state.chatLog, msg] };
}

export function appendNarratorMessage(
  state: GameState,
  channel: ChannelId,
  message: string,
  day: number,
  phase: Phase,
): GameState {
  return appendGeneratedMessage(state, { channel, authorId: NARRATOR_ID, message, day, phase, system: true });
}
