import { isLoversChannel, type ChannelId, type GameState, type PlayerId } from "@mafia/shared";
import { turnBudgetConfig } from "./setup.js";

/** Town chat is day-only; every other channel (mafia, deep_divers, lovers) is night-only. */
export function channelWritableThisPhase(channel: ChannelId, state: GameState): boolean {
  if (channel === "town") return state.phase === "day_discussion";
  return state.phase === "night";
}

export function channelCap(state: GameState, channel: ChannelId): number {
  const cfg = turnBudgetConfig(state);
  if (channel === "town") return cfg.dayDiscussion;
  if (channel === "mafia") return cfg.mafiaNight;
  if (channel === "deep_divers") return cfg.deepDiverNight;
  if (isLoversChannel(channel)) return cfg.loversNight;
  throw new Error(`unknown channel: ${channel}`);
}

function usedCount(state: GameState, playerId: PlayerId, channel: ChannelId): number {
  return state.turnBudgets.used[playerId]?.[channel] ?? 0;
}

/**
 * Town's day_discussion cap is a single shared pool (see TurnBudgetConfig's
 * doc comment) rather than a per-player allowance — this sums every
 * player's own recorded town messages to get the pool's running total.
 * Every other channel stays per-player, gated by usedCount directly.
 */
export function totalTownUsed(state: GameState): number {
  let total = 0;
  for (const byChannel of Object.values(state.turnBudgets.used)) {
    total += byChannel?.town ?? 0;
  }
  return total;
}

export function canSendMessage(state: GameState, playerId: PlayerId, channel: ChannelId): boolean {
  const cap = channelCap(state, channel);
  const used = channel === "town" ? totalTownUsed(state) : usedCount(state, playerId, channel);
  return used < cap;
}

/** Records a sent message against the channel's budget — the shared pool for town, the sender's own allowance for everything else. */
export function recordMessage(state: GameState, playerId: PlayerId, channel: ChannelId): GameState {
  if (!canSendMessage(state, playerId, channel)) {
    throw new Error(`player ${playerId} has no budget remaining in channel ${channel}`);
  }
  const priorOwn = usedCount(state, playerId, channel);
  return {
    ...state,
    turnBudgets: {
      ...state.turnBudgets,
      used: {
        ...state.turnBudgets.used,
        [playerId]: { ...state.turnBudgets.used[playerId], [channel]: priorOwn + 1 },
      },
    },
  };
}

export function resetTurnBudgets(state: GameState): GameState {
  return { ...state, turnBudgets: { used: {}, pingCredits: {} } };
}
