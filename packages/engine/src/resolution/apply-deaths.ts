import type { DeathCause, GameEvent, GameState, PlayerId } from "@mafia/shared";
import { applyDeathOutcome, voidJesterWinIfRevengeTargetIsTanner } from "./death-outcomes.js";
import { evaluateWinConditions, finalizeWinner } from "../win-conditions.js";
import { appendNarratorMessage } from "../narrator.js";
import { displayNameOf } from "../flavor.js";

export interface PendingDeath {
  playerId: PlayerId;
  cause: DeathCause;
}

export interface ProcessDeathsResult {
  state: GameState;
  events: GameEvent[];
  enterJesterRevenge?: { jesterId: PlayerId; eligibleTargets: PlayerId[] };
}

/**
 * Drains a queue of deaths (marking each dead, applying Tanner/Jester
 * outcome tables, scheduling heartbreak cascades, and re-checking win
 * conditions after every single death) until the queue empties or the game
 * ends. Shared by night resolution, day-vote resolution, and the jester
 * revenge sub-phase, since all three can trigger deaths with side effects.
 */
export function processDeaths(
  state: GameState,
  initialDeaths: PendingDeath[],
  day: number,
  votersAgainstByPlayer: Record<PlayerId, PlayerId[]> = {},
  /** Only set when resolving a jester_revenge_subphase kill; needed to void that Jester's win if the target turns out to be a Tanner. */
  jesterRevengeJesterId?: PlayerId,
): ProcessDeathsResult {
  let nextState = state;
  const events: GameEvent[] = [];
  let enterJesterRevenge: ProcessDeathsResult["enterJesterRevenge"];
  const queue = [...initialDeaths];

  while (queue.length > 0) {
    const pending = queue.shift()!;
    const player = nextState.players.find((p) => p.id === pending.playerId);
    if (!player || !player.alive) continue; // already dead / unknown — skip

    nextState = {
      ...nextState,
      players: nextState.players.map((p) =>
        p.id === player.id ? { ...p, alive: false, deathCause: pending.cause, deathDay: day } : p,
      ),
      deaths: [...nextState.deaths, { playerId: player.id, cause: pending.cause, day }],
    };
    events.push({ type: "player_died", playerId: player.id, cause: pending.cause, day });

    // Revealed on every death regardless of cause (vote, night kill,
    // jester revenge, heartbeak cascade, boomerang follow-up, ...) — the
    // one binary fact ("was Mafia" or not) every remaining player needs to
    // gauge how many hostile threats are actually left, without a full role
    // reveal. Placed here in the shared drain loop specifically so it can
    // never be missed for a cascade death that a resolution file's own
    // announcement wouldn't otherwise mention (e.g. a heartbroken partner).
    nextState = appendNarratorMessage(
      nextState,
      "town",
      `${displayNameOf(nextState, player.id)} was ${player.role === "mafia" ? "" : "not "}Mafia.`,
      day,
      nextState.phase,
    );

    // Heartbreak cascade: a Lover's death kills their still-alive partner.
    if (player.loverPairId) {
      const partner = nextState.players.find(
        (p) => p.loverPairId === player.loverPairId && p.id !== player.id && p.alive,
      );
      if (partner) {
        queue.push({ playerId: partner.id, cause: "heartbreak" });
      }
    }

    const outcome = applyDeathOutcome(
      nextState,
      { playerId: player.id, cause: pending.cause, day },
      votersAgainstByPlayer[player.id],
    );
    nextState = outcome.state;
    events.push(...outcome.events);
    queue.push(...outcome.followUpDeaths);

    // Special case: a Jester revenge-killing a Tanner voids the Jester's
    // just-recorded side-win too — "both Tanner and the Jester lose."
    if (pending.cause === "jester_revenge" && player.role === "tanner" && jesterRevengeJesterId) {
      nextState = voidJesterWinIfRevengeTargetIsTanner(nextState, jesterRevengeJesterId, "tanner");
    }

    if (outcome.immediateWinner) {
      // Regression: this used to hand-roll `phase: "post_game"` directly,
      // bypassing finalizeWinner entirely — which meant a Tanner's instant
      // day-vote win skipped the post-game debrief altogether (no
      // debriefQueue ever got seeded), unlike every other win path
      // (evaluateWinConditions below, and the draw-out path in
      // win-conditions.ts) which all already route through it. Found live:
      // a Tanner win ended the game with every seat exiting immediately and
      // zero debrief messages.
      const finalized = finalizeWinner(nextState, outcome.immediateWinner.result, outcome.immediateWinner.winningPlayerIds);
      nextState = finalized.state;
      events.push(...finalized.events);
      break;
    }

    if (outcome.enterJesterRevenge) {
      enterJesterRevenge = outcome.enterJesterRevenge;
    }
  }

  // Win conditions are checked once the whole cascade (including heartbreak
  // and boomerang follow-up deaths) has fully drained, not after each
  // individual death — otherwise a heartbreak death queued alongside its
  // trigger could be cut off by a premature win/loss from the first death
  // alone. A pending Jester revenge defers this check entirely: the
  // sub-phase might still change the outcome (e.g. revenge-killing a
  // Tanner), so resolveJesterRevenge runs the check itself once it's done.
  if (!nextState.winner && !enterJesterRevenge) {
    const winCheck = evaluateWinConditions(nextState);
    nextState = winCheck.state;
    events.push(...winCheck.events);
  }

  return { state: nextState, events, enterJesterRevenge };
}
