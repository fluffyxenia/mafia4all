import {
  buildPlayerView,
  channelWritableThisPhase,
  currentChannelTurn,
  currentDayTurn,
  currentDebriefTurn,
  currentVoteTurn,
} from "@mafia/engine";
import { ROLE_NIGHT_ACTIONS, joatChargeKey, type ChannelId, type GameState, type NightActionType, type PlayerId } from "@mafia/shared";

/**
 * Which tools (and, for night_action, which specific action types) are
 * actually usable by this player right now. Purely advisory for the MCP
 * tool list — every handler in session.ts re-validates the same rules
 * server-side regardless — but showing a small/local model only the moves
 * that can actually succeed avoids it wasting a turn (and, for a model that
 * doesn't recover well from a rejection, getting stuck) on something that
 * was never going to work: voting outside day_vote, or reaching for a JoAT
 * charge it already spent.
 */
export interface ToolAvailability {
  sendChat: { enabled: boolean; allowedChannels: ChannelId[] };
  pingPlayer: { enabled: boolean; allowedTargets: PlayerId[] };
  castVote: boolean;
  nightAction: { enabled: boolean; allowedActionTypes: NightActionType[] };
  jesterRevenge: boolean;
  pass: boolean;
}

export function computeToolAvailability(state: GameState, playerId: PlayerId): ToolAvailability {
  // The post-game debrief is a wholly separate mechanic from everything
  // else here: every rule below assumes `alive` gates participation and a
  // resettable per-phase budget limits it, neither of which apply once the
  // game's over — a dead player still gets their one final word, gated
  // purely by debriefQueue membership (see debrief.ts), not by role, phase
  // budgets, or being alive.
  if (state.phase === "debrief") {
    const isMyDebriefTurn = currentDebriefTurn(state) === playerId;
    return {
      sendChat: { enabled: isMyDebriefTurn, allowedChannels: isMyDebriefTurn ? ["town"] : [] },
      pingPlayer: { enabled: false, allowedTargets: [] },
      castVote: false,
      nightAction: { enabled: false, allowedActionTypes: [] },
      jesterRevenge: false,
      pass: false,
    };
  }

  const player = state.players.find((p) => p.id === playerId);
  const alive = player?.alive ?? false;
  // The Jester acts once more after being eliminated, so their one legal
  // moment to act is specifically while dead — everything else here requires
  // being alive.
  const isPendingJester = state.phase === "jester_revenge_subphase" && state.pendingJesterRevenge?.jesterId === playerId;

  // Once a player has submitted any night action tonight (including
  // `pass`), night_action must stop being offered — without this, the tool
  // stays available indefinitely and a player (human or AI) can keep
  // resubmitting all night, each call silently replacing their prior
  // submission. AI seats are separately guarded against re-prompting
  // themselves once committed (see AgentLoop's committedThisPhase), but
  // that's an AgentLoop-only safeguard — a human using the actual client
  // has nothing stopping them from doing this, which is exactly how this
  // was found in real testing.
  const alreadyActedTonight =
    state.phase === "night" && state.nightActions.some((a) => a.actorId === playerId && a.day === state.dayNumber);

  const allowedActionTypes =
    alive && state.phase === "night" && player && !alreadyActedTonight
      ? (ROLE_NIGHT_ACTIONS[player.role] ?? []).filter((actionType) => {
          const chargeKey = joatChargeKey(actionType);
          if (!chargeKey) return true;
          return player.joatCharges?.[chargeKey] ?? false;
        })
      : [];

  // Of the channels this player belongs to at all (town always; mafia/
  // deep_divers/lovers only for members), only the ones actually writable
  // this phase — town by day, everything else by night. A plain Town
  // player, say, has no writable channel at night at all. Town additionally
  // requires it actually being this player's turn (randomized turn order —
  // see day-turn-order.ts); private team channels have no such gate.
  const isMyTurn = currentDayTurn(state) === playerId;
  // Every writable channel is turn-ordered now, not just town — town uses
  // its own dayTurnQueue/dayPingQueue (with ping support), every other
  // channel (mafia, deep_divers, lovers) uses the generalized
  // channelTurnQueues mechanism. See channel-turn-order.ts.
  const isMyChannelTurn = (channel: ChannelId): boolean =>
    channel === "town" ? isMyTurn : currentChannelTurn(state, channel) === playerId;
  const allowedChannels = alive
    ? buildPlayerView(state, playerId)
        .visibleChannels.filter((channel) => channelWritableThisPhase(channel, state))
        .filter(isMyChannelTurn)
    : [];

  const hasNightAction = alive && allowedActionTypes.length > 0;

  // Every other living player — never yourself. Pinging yourself would
  // grant yourself a free reply credit and jump yourself to the front of
  // the day's ping queue, an infinite self-sustaining loop that can stall
  // day_discussion forever (dayDiscussionReady requires every alive player
  // to be genuinely out of turns).
  const canPing = alive && state.phase === "day_discussion" && isMyTurn;
  const allowedTargets = canPing ? state.players.filter((p) => p.alive && p.id !== playerId).map((p) => p.id) : [];

  return {
    sendChat: { enabled: allowedChannels.length > 0, allowedChannels },
    pingPlayer: { enabled: canPing && allowedTargets.length > 0, allowedTargets },
    // Sequential, like day_discussion's speaking order — otherwise every
    // alive player's cast_vote appears the instant day_vote begins, and
    // every AI seat's LLM fires simultaneously instead of one at a time.
    castVote: alive && state.phase === "day_vote" && currentVoteTurn(state) === playerId,
    nightAction: { enabled: hasNightAction, allowedActionTypes },
    jesterRevenge: isPendingJester,
    // Only offer "pass" at night where there's actually a night action to
    // decline — a role with no night action at all (e.g. plain Town) has
    // nothing to pass on, and advertising it anyway is exactly the kind of
    // phantom turn that burns a wasted LLM call on nothing (see the module
    // doc comment above). day_discussion deliberately has NO pass at all:
    // it used to let a player silently give up every remaining turn for the
    // rest of the day, a one-way ticket out of the conversation — unable to
    // respond even if later accused. A player with nothing new to add
    // during the day must send_chat and say so; that costs one of their
    // normal turns like any other message, and leaves them free to speak
    // again next round.
    pass: isPendingJester || (state.phase === "night" && hasNightAction),
  };
}
