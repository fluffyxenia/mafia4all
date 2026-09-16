import type { GameState, PlayerId } from "@mafia/shared";
import { canSendMessage } from "./turn-budget.js";
import { shuffleWithState } from "./rng.js";

/** Alive players who could still contribute a normal (non-ping) turn this cycle. */
function eligibleForDayTurn(state: GameState): PlayerId[] {
  return state.players.filter((p) => p.alive && canSendMessage(state, p.id, "town")).map((p) => p.id);
}

/**
 * Starts (or restarts) the day-discussion turn cycle with a fresh random
 * order, clearing any pending pings — called whenever a cycle runs out
 * mid-phase (see advanceDayTurn), when a night resolves into a new day's
 * discussion (see advance.ts), and when "request more messages" bounces a
 * vote back into discussion (see resolveDayVote), so "reshuffle every day"
 * and "reshuffle every full cycle" are the same mechanism: day start is
 * just cycle one.
 *
 * `avoidFirst`, when given, keeps that player from landing first in the new
 * cycle as long as anyone else is eligible — without it, a plain reshuffle
 * has a real (and with few players left, large) chance of putting whoever
 * just finished speaking right back at the front, which reads as "the same
 * player going twice in a row" rather than as randomization. With exactly
 * two eligible players this forces strict alternation, which is correct:
 * that's the only fair option once nobody else is left to include. Every
 * call site should pass the state's `lastTownSpeakerId` for this reason —
 * the two call sites that resolve a phase transition (rather than a
 * mid-cycle exhaustion, which already has the just-spoken player in hand as
 * an ordinary function argument) used to omit it entirely, letting the last
 * speaker before a night or a "request more messages" vote open the very
 * next cycle too.
 */
export function reshuffleDayTurnOrder(state: GameState, avoidFirst?: PlayerId): GameState {
  const { result, nextSeed } = shuffleWithState(eligibleForDayTurn(state), state.rngState);
  if (avoidFirst && result.length > 1 && result[0] === avoidFirst) {
    [result[0], result[1]] = [result[1]!, result[0]!];
  }
  return { ...state, rngState: nextSeed, dayTurnQueue: result, dayPingQueue: [] };
}

/** Whose turn it is to speak in town chat right now, if anyone — pinged players go first, FIFO. */
export function currentDayTurn(state: GameState): PlayerId | undefined {
  return state.dayPingQueue[0] ?? state.dayTurnQueue[0];
}

/**
 * Called after a player successfully speaks in town chat: clears them from
 * whichever queue(s) they were satisfying. Checks both queues rather than
 * either/or — if a player happens to sit at the front of both at once (they
 * were just pinged AND already up next in the normal cycle), one message
 * must clear both obligations. Popping only the ping queue in that case (as
 * this used to do) left them at the front of the normal queue too, so
 * `currentDayTurn` immediately called on them again for a second turn in a
 * row with nobody else speaking in between — found in real testing as a
 * player getting three turns in quick succession. Reshuffles a fresh cycle
 * the moment the normal queue empties, so play never stalls waiting on a
 * cycle that's already finished.
 */
export function advanceDayTurn(state: GameState, playerId: PlayerId): GameState {
  let next: GameState = { ...state, lastTownSpeakerId: playerId };
  if (next.dayPingQueue[0] === playerId) {
    next = { ...next, dayPingQueue: next.dayPingQueue.slice(1) };
  }
  if (next.dayTurnQueue[0] === playerId) {
    const remaining = next.dayTurnQueue.slice(1);
    next =
      remaining.length === 0
        ? reshuffleDayTurnOrder({ ...next, dayTurnQueue: [] }, playerId)
        : { ...next, dayTurnQueue: remaining };
  }
  return next;
}

/**
 * Called when a player pings another during day_discussion: the target is
 * owed the next reply (after anyone already ping-queued ahead of them),
 * without disturbing the normal cycle's order otherwise.
 */
export function enqueuePing(state: GameState, targetId: PlayerId): GameState {
  if (state.dayPingQueue.includes(targetId)) return state;
  return { ...state, dayPingQueue: [...state.dayPingQueue, targetId] };
}

/**
 * Seeds the day_vote turn order with every currently-alive player, shuffled
 * — called exactly once, at the day_discussion -> day_vote transition.
 * Unlike the day-discussion cycle this never reshuffles: voting is a single
 * pass, one vote per player, not a repeating multi-round cycle, so there's
 * no "cycle emptied, start another" case to handle.
 */
export function initializeVoteQueue(state: GameState): GameState {
  const alive = state.players.filter((p) => p.alive).map((p) => p.id);
  const { result, nextSeed } = shuffleWithState(alive, state.rngState);
  return { ...state, rngState: nextSeed, dayVoteQueue: result };
}

/** Whose turn it is to cast a vote right now, if anyone. */
export function currentVoteTurn(state: GameState): PlayerId | undefined {
  return state.dayVoteQueue[0];
}

/** Called after a player successfully votes: drops them from the queue. */
export function advanceVoteQueue(state: GameState, playerId: PlayerId): GameState {
  if (state.dayVoteQueue[0] !== playerId) return state;
  return { ...state, dayVoteQueue: state.dayVoteQueue.slice(1) };
}
