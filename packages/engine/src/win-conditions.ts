import {
  HOSTILE_ROLES,
  TOWN_ALIGNED_ROLES,
  type GameEvent,
  type GameState,
  type PlayerId,
} from "@mafia/shared";

/**
 * Every player who was ever seated, dead or alive, in original seat order —
 * the post-game debrief owes each of them exactly one final message, not
 * just the survivors.
 */
function allPlayersInSeatOrder(state: GameState): PlayerId[] {
  return state.players.map((p) => p.id);
}

export function finalizeWinner(
  state: GameState,
  result: NonNullable<GameState["winner"]>["result"],
  winningPlayerIds: PlayerId[],
): { state: GameState; events: GameEvent[] } {
  const nextState: GameState = {
    ...state,
    phase: "debrief",
    winner: { result, winningPlayerIds },
    debriefQueue: allPlayersInSeatOrder(state),
  };
  return { state: nextState, events: [{ type: "game_over", result, winningPlayerIds }] };
}

/**
 * Pure numeric board-state evaluator for the faction win/loss conditions.
 * Must be re-run after every state mutation that changes who's alive, since
 * e.g. a heartbreak death mid-resolution can itself flip a win/loss. Does
 * NOT handle draw-out (counter-based, checked by day-vote resolution) or
 * Tanner/Jester side-wins (cause-based, checked by death-outcomes).
 */
export function evaluateWinConditions(state: GameState): { state: GameState; events: GameEvent[] } {
  if (state.winner) return { state, events: [] };

  const alive = state.players.filter((p) => p.alive);
  const townAligned = alive.filter((p) => TOWN_ALIGNED_ROLES.has(p.role));
  const hostile = alive.filter((p) => HOSTILE_ROLES.has(p.role));
  const mafiaAlive = alive.filter((p) => p.role === "mafia");
  const skAlive = alive.filter((p) => p.role === "serial_killer");

  // Serial Killer wins by being the sole survivor on the whole board.
  if (alive.length === 1 && skAlive.length === 1) {
    return finalizeWinner(state, "serial_killer", [skAlive[0]!.id]);
  }

  // Mafia wins when every non-Mafia-aligned player is gone (implies SK is
  // also gone, since SK counts as non-Mafia).
  if (mafiaAlive.length > 0 && alive.length === mafiaAlive.length) {
    return finalizeWinner(state, "mafia", mafiaAlive.map((p) => p.id));
  }

  // Town wins once every hostile threat (Mafia, SK) is eliminated.
  if (hostile.length === 0) {
    return finalizeWinner(state, "town", townAligned.map((p) => p.id));
  }

  // Town loses once it can no longer outnumber the hostile threats.
  if (townAligned.length <= hostile.length) {
    const result = hostile.some((p) => p.role === "mafia") ? "mafia" : "serial_killer";
    return finalizeWinner(state, result, hostile.map((p) => p.id));
  }

  return { state, events: [] };
}

const DRAW_OUT_LIMIT = 3;

export function incrementDrawOut(state: GameState): { state: GameState; events: GameEvent[] } {
  const count = state.drawOutCounter + 1;
  if (count >= DRAW_OUT_LIMIT) {
    const nextState: GameState = {
      ...state,
      drawOutCounter: count,
      phase: "debrief",
      winner: { result: "draw_out", winningPlayerIds: [] },
      debriefQueue: allPlayersInSeatOrder(state),
    };
    return {
      state: nextState,
      events: [
        { type: "draw_out_incremented", count },
        { type: "game_over", result: "draw_out", winningPlayerIds: [] },
      ],
    };
  }
  return {
    state: { ...state, drawOutCounter: count },
    events: [{ type: "draw_out_incremented", count }],
  };
}

export function resetDrawOut(state: GameState): { state: GameState; events: GameEvent[] } {
  if (state.drawOutCounter === 0) return { state, events: [] };
  return { state: { ...state, drawOutCounter: 0 }, events: [{ type: "draw_out_reset" }] };
}
