import type { GameState, PlayerId } from "@mafia/shared";

/** Whose turn it is to give their one final debrief message, if anyone. */
export function currentDebriefTurn(state: GameState): PlayerId | undefined {
  return state.debriefQueue[0];
}

/**
 * Called after a player successfully sends their debrief message: drops
 * them from the queue. Single pass, no reshuffle — once everyone seated has
 * had their turn, `debriefReady` (see advance.ts) lets the game move on to
 * the truly-terminal `post_game`.
 */
export function advanceDebriefQueue(state: GameState, playerId: PlayerId): GameState {
  if (state.debriefQueue[0] !== playerId) return state;
  return { ...state, debriefQueue: state.debriefQueue.slice(1) };
}
