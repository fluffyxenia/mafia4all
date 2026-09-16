import type { GameEvent, GameState, PlayerId } from "@mafia/shared";
import { processDeaths } from "./apply-deaths.js";
import { evaluateWinConditions } from "../win-conditions.js";
import { resetTurnBudgets } from "../turn-budget.js";
import { appendGeneratedMessage, appendNarratorMessage } from "../narrator.js";
import { defaultJesterRevengeStatement, displayNameOf } from "../flavor.js";
import { initializeChannelTurnQueuesForNight } from "../channel-turn-order.js";

/**
 * Resolves the jester_revenge_subphase: an optional revenge kill against one
 * of the Jester's day-vote accusers, then transitions to night. `targetId`
 * omitted means the Jester declined to use their revenge.
 */
export function resolveJesterRevenge(
  state: GameState,
  targetId: PlayerId | undefined,
  reasoning?: string,
): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingJesterRevenge;
  if (!pending) throw new Error("no jester revenge is pending");

  const events: GameEvent[] = [];
  let nextState: GameState = { ...state, pendingJesterRevenge: undefined };

  if (targetId) {
    const statement = reasoning?.trim() || defaultJesterRevengeStatement(displayNameOf(state, targetId));
    nextState = appendGeneratedMessage(nextState, {
      channel: "town",
      authorId: pending.jesterId,
      message: statement,
      day: pending.day,
      phase: "jester_revenge_subphase",
    });

    const deathResult = processDeaths(
      nextState,
      [{ playerId: targetId, cause: "jester_revenge" }],
      pending.day,
      {},
      pending.jesterId,
    );
    nextState = deathResult.state;
    events.push(...deathResult.events);

    // Announced even if this death also just ended the game.
    nextState = appendNarratorMessage(
      nextState,
      "town",
      `${displayNameOf(state, targetId)} is eliminated in the Jester's revenge.`,
      pending.day,
      "jester_revenge_subphase",
    );
  } else {
    nextState = appendNarratorMessage(
      nextState,
      "town",
      `${displayNameOf(state, pending.jesterId)} chooses not to take revenge.`,
      pending.day,
      "jester_revenge_subphase",
    );
  }

  if (nextState.winner) {
    return { state: nextState, events };
  }

  const finalCheck = evaluateWinConditions(nextState);
  nextState = finalCheck.state;
  events.push(...finalCheck.events);

  if (!nextState.winner) {
    nextState = { ...nextState, phase: "night", dayNumber: pending.day + 1 };
    nextState = resetTurnBudgets(nextState);
    nextState = initializeChannelTurnQueuesForNight(nextState);
  }

  return { state: nextState, events };
}
