import { isLoversChannel, loversChannel, type ChannelId, type GameState, type Player, type PlayerId } from "@mafia/shared";
import { canSendMessage } from "./turn-budget.js";
import { shuffleWithState } from "./rng.js";

/**
 * Duplicated from reducer.ts's private playerBelongsToChannel (and
 * view.ts's near-identical channelVisibleToPlayer) rather than shared,
 * to avoid a circular import (reducer.ts already imports from this module's
 * sibling day-turn-order.ts) — small and stable enough that the
 * duplication is cheaper than a refactor here.
 */
function playerBelongsToChannel(player: Player, channel: ChannelId): boolean {
  if (channel === "town") return true;
  if (channel === "mafia") return player.role === "mafia";
  if (channel === "deep_divers") return player.role === "deep_diver";
  if (isLoversChannel(channel)) return channel === loversChannel(player.loverPairId ?? "");
  return false;
}

/** Every non-town channel currently structurally in play: mafia/deep_divers if anyone holds that role, plus one per lover pair. */
export function activeTeamChannels(state: GameState): ChannelId[] {
  const channels: ChannelId[] = [];
  if (state.players.some((p) => p.role === "mafia")) channels.push("mafia");
  if (state.players.some((p) => p.role === "deep_diver")) channels.push("deep_divers");
  const pairIds = new Set(state.players.map((p) => p.loverPairId).filter(Boolean) as string[]);
  for (const pairId of pairIds) channels.push(loversChannel(pairId));
  return channels;
}

/** Alive members of `channel` who still have budget to send there this cycle. */
function eligibleForChannelTurn(state: GameState, channel: ChannelId): PlayerId[] {
  return state.players
    .filter((p) => p.alive && playerBelongsToChannel(p, channel) && canSendMessage(state, p.id, channel))
    .map((p) => p.id);
}

/**
 * Starts (or restarts) a channel's turn cycle with a fresh random order —
 * the non-town counterpart to day-turn-order.ts's reshuffleDayTurnOrder,
 * generalized across mafia/deep_divers/lovers instead of being town-only.
 * See that function's doc comment for why `avoidFirst` matters.
 */
export function reshuffleChannelTurnOrder(state: GameState, channel: ChannelId, avoidFirst?: PlayerId): GameState {
  const { result, nextSeed } = shuffleWithState(eligibleForChannelTurn(state, channel), state.rngState);
  if (avoidFirst && result.length > 1 && result[0] === avoidFirst) {
    [result[0], result[1]] = [result[1]!, result[0]!];
  }
  return {
    ...state,
    rngState: nextSeed,
    channelTurnQueues: { ...state.channelTurnQueues, [channel]: result },
  };
}

/** Reshuffles every structurally-active team channel fresh — called whenever the game enters a new night. */
export function initializeChannelTurnQueuesForNight(state: GameState): GameState {
  let next = state;
  for (const channel of activeTeamChannels(next)) {
    if (eligibleForChannelTurn(next, channel).length === 0) continue;
    next = reshuffleChannelTurnOrder(next, channel, next.lastChannelSpeakerId[channel]);
  }
  return next;
}

/** Whose turn it is to speak in `channel` right now, if anyone. */
export function currentChannelTurn(state: GameState, channel: ChannelId): PlayerId | undefined {
  return state.channelTurnQueues[channel]?.[0];
}

/** Called after a player successfully speaks in a non-town channel: advances (and reshuffles-on-empty) its queue. */
export function advanceChannelTurn(state: GameState, channel: ChannelId, playerId: PlayerId): GameState {
  const queue = state.channelTurnQueues[channel];
  if (!queue || queue[0] !== playerId) return state;

  const next: GameState = {
    ...state,
    lastChannelSpeakerId: { ...state.lastChannelSpeakerId, [channel]: playerId },
  };
  const remaining = queue.slice(1);
  if (remaining.length === 0) {
    // A lone remaining member has nobody else to defer to — reshuffling
    // would trivially hand them their own turn right back, forever, since
    // there's no one else the queue could ever contain. Found in real
    // testing as a solo Deep Diver spamming near-duplicate "no target,
    // passing" messages every idle-nudge cycle until their whole night's
    // message budget was burned on nothing. Leave the queue empty for the
    // rest of this night instead — initializeChannelTurnQueuesForNight
    // opens it fresh again next night regardless of who spoke last, so
    // this only suppresses the same-night immediate self-repeat, not a
    // genuine multi-member back-and-forth (which still needs to keep
    // cycling for real negotiation, e.g. Mafia converging on a target).
    if (eligibleForChannelTurn(next, channel).every((id) => id === playerId)) {
      return { ...next, channelTurnQueues: { ...next.channelTurnQueues, [channel]: [] } };
    }
    return reshuffleChannelTurnOrder(
      { ...next, channelTurnQueues: { ...next.channelTurnQueues, [channel]: [] } },
      channel,
      playerId,
    );
  }
  return { ...next, channelTurnQueues: { ...next.channelTurnQueues, [channel]: remaining } };
}
