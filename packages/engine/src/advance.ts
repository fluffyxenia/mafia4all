import { ROLE_NIGHT_ACTIONS, type GameEvent, type GameState } from "@mafia/shared";
import { canSendMessage } from "./turn-budget.js";
import { resolveNight } from "./resolution/night.js";
import { resolveDayVote } from "./resolution/day-vote.js";
import { initializeVoteQueue, reshuffleDayTurnOrder } from "./day-turn-order.js";

function nightReady(state: GameState): boolean {
  const actionable = state.players.filter((p) => p.alive && ROLE_NIGHT_ACTIONS[p.role]);
  return actionable.every((p) => {
    const hasRecord = state.nightActions.some((a) => a.actorId === p.id && a.day === state.dayNumber);
    if (hasRecord) return true;
    if (p.role === "mafia") return !canSendMessage(state, p.id, "mafia");
    if (p.role === "deep_diver") return !canSendMessage(state, p.id, "deep_divers");
    return false;
  });
}

function dayDiscussionReady(state: GameState): boolean {
  const alive = state.players.filter((p) => p.alive);
  return alive.every((p) => !canSendMessage(state, p.id, "town"));
}

function dayVoteReady(state: GameState): boolean {
  const alive = state.players.filter((p) => p.alive);
  return alive.every((p) => state.votes.some((v) => v.voterId === p.id && v.day === state.dayNumber));
}

/** Ready once every seated player — dead or alive — has had their one final debrief message. */
function debriefReady(state: GameState): boolean {
  return state.debriefQueue.length === 0;
}

/**
 * Checks whether the current phase's exit condition is met (every eligible
 * actor has submitted/passed, per the message-count-based pacing model —
 * there is no wall clock) and, if so, resolves it and transitions to the
 * next phase. Returns null if the phase isn't ready to advance yet.
 */
export function tryAdvancePhase(state: GameState): { state: GameState; events: GameEvent[] } | null {
  switch (state.phase) {
    case "night": {
      if (!nightReady(state)) return null;
      const result = resolveNight(state);
      const events: GameEvent[] = [...result.events];
      let nextState = result.state;
      if (!nextState.winner) {
        events.push({ type: "phase_changed", from: "night", to: "day_discussion", day: nextState.dayNumber });
        nextState = reshuffleDayTurnOrder(
          { ...nextState, phase: "day_discussion" },
          nextState.lastTownSpeakerId,
        );
      }
      return { state: nextState, events };
    }
    case "day_discussion": {
      if (!dayDiscussionReady(state)) return null;
      const events: GameEvent[] = [
        { type: "phase_changed", from: "day_discussion", to: "day_vote", day: state.dayNumber },
      ];
      return { state: initializeVoteQueue({ ...state, phase: "day_vote" }), events };
    }
    case "day_vote": {
      if (!dayVoteReady(state)) return null;
      return resolveDayVote(state);
    }
    case "debrief": {
      if (!debriefReady(state)) return null;
      const events: GameEvent[] = [{ type: "phase_changed", from: "debrief", to: "post_game", day: state.dayNumber }];
      return { state: { ...state, phase: "post_game" }, events };
    }
    default:
      return null;
  }
}
