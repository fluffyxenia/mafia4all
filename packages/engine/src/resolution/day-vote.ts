import type { GameEvent, GameState, PlayerId, VoteTarget } from "@mafia/shared";
import { processDeaths } from "./apply-deaths.js";
import { evaluateWinConditions, incrementDrawOut, resetDrawOut } from "../win-conditions.js";
import { resetTurnBudgets } from "../turn-budget.js";
import { appendNarratorMessage } from "../narrator.js";
import { displayNameOf } from "../flavor.js";
import { reshuffleDayTurnOrder } from "../day-turn-order.js";
import { initializeChannelTurnQueuesForNight } from "../channel-turn-order.js";

function tally(targets: VoteTarget[]): { winner?: VoteTarget; tied: boolean } {
  if (targets.length === 0) return { tied: false };
  const counts = new Map<VoteTarget, number>();
  for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
  let winner: VoteTarget | undefined;
  let winnerCount = 0;
  let tied = false;
  for (const [target, count] of counts) {
    if (count > winnerCount) {
      winner = target;
      winnerCount = count;
      tied = false;
    } else if (count === winnerCount) {
      tied = true;
    }
  }
  return { winner, tied };
}

/**
 * Resolves the current day's vote and transitions to the next phase:
 * 'night' (elimination or no-elimination outcome), 'jester_revenge_subphase'
 * (the eliminated player was the Jester), or back to 'day_discussion' (the
 * "request more messages" option won, once-per-day only).
 */
export function resolveDayVote(state: GameState): { state: GameState; events: GameEvent[] } {
  const day = state.dayNumber;
  const dayVotes = state.votes.filter((v) => v.day === day);
  const { winner, tied } = tally(dayVotes.map((v) => v.target));

  const events: GameEvent[] = [];

  if (!tied && winner === "request_more_messages" && !state.requestMoreMessagesUsedToday) {
    let nextState: GameState = {
      ...state,
      requestMoreMessagesUsedToday: true,
      phase: "day_discussion",
    };
    nextState = resetTurnBudgets(nextState);
    nextState = reshuffleDayTurnOrder(nextState, nextState.lastTownSpeakerId);
    nextState = appendNarratorMessage(
      nextState,
      "town",
      "The town has voted to extend discussion.",
      day,
      "day_discussion",
    );
    events.push({ type: "request_more_messages_granted", day });
    return { state: nextState, events };
  }

  const isPlayerTarget = !tied && winner && winner !== "abstain" && winner !== "request_more_messages";

  if (!isPlayerTarget) {
    // Tie, or plurality "abstain" (or a stale/already-used request), or no votes at all.
    const drawOut = incrementDrawOut(state);
    let nextState = drawOut.state;
    events.push(...drawOut.events);
    if (!nextState.winner) {
      nextState = appendNarratorMessage(nextState, "town", "No one was eliminated today.", day, "day_vote");
      nextState = { ...nextState, phase: "night", dayNumber: day + 1 };
      nextState = resetTurnBudgets(nextState);
      nextState = initializeChannelTurnQueuesForNight(nextState);
    } else {
      nextState = appendNarratorMessage(
        nextState,
        "town",
        "Three days have passed with no resolution — the game ends in a draw.",
        day,
        "day_vote",
      );
    }
    return { state: nextState, events };
  }

  const eliminatedId = winner as PlayerId;
  const votersAgainst = dayVotes.filter((v) => v.target === eliminatedId).map((v) => v.voterId);

  const stateWithAnnouncement = appendNarratorMessage(
    state,
    "town",
    `${displayNameOf(state, eliminatedId)} was voted out with ${votersAgainst.length} vote(s).`,
    day,
    "day_vote",
  );

  const deathResult = processDeaths(
    stateWithAnnouncement,
    [{ playerId: eliminatedId, cause: "day_vote" }],
    day,
    { [eliminatedId]: votersAgainst },
  );
  events.push(...deathResult.events);
  let nextState = deathResult.state;

  if (nextState.winner) {
    return { state: nextState, events };
  }

  if (deathResult.enterJesterRevenge) {
    const reset = resetDrawOut(nextState);
    nextState = reset.state;
    events.push(...reset.events);
    nextState = {
      ...nextState,
      phase: "jester_revenge_subphase",
      pendingJesterRevenge: { ...deathResult.enterJesterRevenge, day },
    };
    return { state: nextState, events };
  }

  const reset = resetDrawOut(nextState);
  nextState = reset.state;
  events.push(...reset.events);

  const finalCheck = evaluateWinConditions(nextState);
  nextState = finalCheck.state;
  events.push(...finalCheck.events);

  if (!nextState.winner) {
    nextState = { ...nextState, phase: "night", dayNumber: day + 1 };
    nextState = resetTurnBudgets(nextState);
    nextState = initializeChannelTurnQueuesForNight(nextState);
  }

  return { state: nextState, events };
}
