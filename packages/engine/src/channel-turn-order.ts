import {
  ROLE_NIGHT_ACTIONS,
  TEAM_CHAT_ACTIONS,
  isLoversChannel,
  loversChannel,
  type ChannelId,
  type GameState,
  type NightActionType,
  type Player,
  type PlayerId,
} from "@mafia/shared";
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

/**
 * Where a team-coordinated role (Mafia, Deep Diver) stands this night in
 * their shared channel's turn rotation — the single source of truth both
 * tool-availability.ts (advisory) and reducer.ts (enforced) read from, so
 * the two can't drift on when a kill proposal/investigation is actually
 * offered.
 *
 * Two free turns, then a forced third: a member may spend their first two
 * turns this night on either plain chat or their team action (letting
 * discussion/course-correction happen before committing), but if they still
 * haven't submitted it by their own 3rd turn, that turn offers the team
 * action only — no chat escape — guaranteeing everyone locks in a target
 * before the night can stall out on pure back-and-forth. Submitting earlier
 * doesn't forfeit later turns; it can still be revised on a subsequent turn
 * like any other proposal update.
 */
export interface TeamTurnStatus {
  actionType: NightActionType;
  channel: ChannelId;
  /** Whether it's genuinely this player's turn in `channel`'s queue right now. */
  isMyTurn: boolean;
  /** How many messages (chat or team-action announcements) this player has posted in `channel` tonight. */
  turnsTakenTonight: number;
  /** Whether this player has already submitted `actionType` tonight (possibly more than once — each resubmission replaces the last). */
  hasActedTonight: boolean;
  /** True once it's their turn, they've had two turns already, and still haven't acted — the team action is the only legal move. */
  mustActNow: boolean;
}

/** Undefined for any role with no team-coordinated night action (i.e. everyone but Mafia/Deep Diver). */
export function teamTurnStatusFor(state: GameState, playerId: PlayerId): TeamTurnStatus | undefined {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return undefined;
  const roleActions = ROLE_NIGHT_ACTIONS[player.role] ?? [];
  const actionType = roleActions.find((a) => a in TEAM_CHAT_ACTIONS);
  if (!actionType) return undefined;
  const channel = TEAM_CHAT_ACTIONS[actionType]!;

  const isMyTurn = state.phase === "night" && currentChannelTurn(state, channel) === playerId;
  const turnsTakenTonight = state.chatLog.filter(
    (m) => m.channel === channel && m.authorId === playerId && m.day === state.dayNumber && m.phase === "night",
  ).length;
  const hasActedTonight = state.nightActions.some(
    (a) => a.actorId === playerId && a.day === state.dayNumber && a.actionType === actionType,
  );
  return {
    actionType,
    channel,
    isMyTurn,
    turnsTakenTonight,
    hasActedTonight,
    mustActNow: isMyTurn && turnsTakenTonight >= 2 && !hasActedTonight,
  };
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
    //
    // Exception: a lone member who still hasn't submitted their team action
    // (mafia_kill_proposal/deep_diver_investigate) needs to keep getting
    // turns regardless — otherwise a solo remaining Mafia member could chat
    // their way through the night (2 free turns, same as anyone) and never
    // actually reach the forced 3rd turn from teamTurnStatusFor, since
    // there'd be no one left to hand the queue back to. Looping them back
    // only while genuinely still pending preserves the original fix above
    // (no endless self-repeat once there's truly nothing left to do).
    if (eligibleForChannelTurn(next, channel).every((id) => id === playerId)) {
      const status = teamTurnStatusFor(next, playerId);
      const stillPending = status && !status.hasActedTonight;
      return {
        ...next,
        channelTurnQueues: { ...next.channelTurnQueues, [channel]: stillPending ? [playerId] : [] },
      };
    }
    return reshuffleChannelTurnOrder(
      { ...next, channelTurnQueues: { ...next.channelTurnQueues, [channel]: [] } },
      channel,
      playerId,
    );
  }
  return { ...next, channelTurnQueues: { ...next.channelTurnQueues, [channel]: remaining } };
}
