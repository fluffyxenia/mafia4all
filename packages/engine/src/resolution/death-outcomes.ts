import type { DeathCause, DeathEvent, GameEvent, GameState, PlayerId } from "@mafia/shared";

type CauseCategory =
  | "day_vote"
  | "mafia_kill"
  | "sk_kill"
  | "vigilante_kill"
  | "joat_kill"
  | "jester_revenge"
  | "heartbreak";

function causeCategory(cause: DeathCause): CauseCategory {
  if (cause.startsWith("sk_kill")) return "sk_kill";
  if (cause.startsWith("vigilante_kill")) return "vigilante_kill";
  return cause as CauseCategory;
}

function attackerIdFromCause(cause: DeathCause): PlayerId | undefined {
  const idx = cause.indexOf(":");
  return idx === -1 ? undefined : cause.slice(idx + 1);
}

export interface DeathOutcomeResult {
  state: GameState;
  events: GameEvent[];
  /** Extra deaths this outcome causes (e.g. a boomeranged attacker), to be resolved next. */
  followUpDeaths: DeathEvent[];
  /** Set when a just-voted-out Jester should enter the revenge sub-phase. */
  enterJesterRevenge?: { jesterId: PlayerId; eligibleTargets: PlayerId[] };
  /** Set when this death instantly ends the whole game (Tanner day-vote win). */
  immediateWinner?: { result: "tanner"; winningPlayerIds: PlayerId[] };
}

/**
 * Applies a single player's death (already marked `alive: false` by the
 * caller) against the README's per-role/per-cause outcome tables. Handles
 * Tanner and Jester's side-win branching; every other role has no special
 * outcome beyond simply dying.
 */
export function applyDeathOutcome(
  state: GameState,
  death: DeathEvent,
  votersAgainst?: PlayerId[],
): DeathOutcomeResult {
  const player = state.players.find((p) => p.id === death.playerId);
  if (!player) throw new Error(`unknown player in death event: ${death.playerId}`);

  const category = causeCategory(death.cause);
  const events: GameEvent[] = [];
  const followUpDeaths: DeathEvent[] = [];
  let nextState = state;

  if (player.role === "tanner") {
    if (category === "day_vote") {
      return {
        state: nextState,
        events,
        followUpDeaths,
        immediateWinner: { result: "tanner", winningPlayerIds: [player.id] },
      };
    }
    if (category === "mafia_kill") {
      // "The Mafia lose and both are eliminated" — the whole Mafia faction
      // is killed by the boomerang, not merely forfeited. The game
      // continues afterward if another threat (e.g. an SK) is still alive.
      for (const p of nextState.players) {
        if (p.role === "mafia" && p.alive) {
          followUpDeaths.push({ playerId: p.id, cause: "tanner_boomerang", day: death.day });
        }
      }
      nextState = {
        ...nextState,
        sideWins: [
          ...nextState.sideWins,
          { playerId: player.id, role: "tanner", reason: "mafia_kill", day: death.day },
        ],
      };
      return { state: nextState, events, followUpDeaths };
    }
    if (category === "sk_kill") {
      // Same boomerang logic: the specific SK who took the shot dies too.
      const attackerId = attackerIdFromCause(death.cause);
      if (attackerId) {
        followUpDeaths.push({ playerId: attackerId, cause: "tanner_boomerang", day: death.day });
      }
      nextState = {
        ...nextState,
        sideWins: [
          ...nextState.sideWins,
          { playerId: player.id, role: "tanner", reason: "sk_kill", day: death.day },
        ],
      };
      return { state: nextState, events, followUpDeaths };
    }
    // vigilante_kill, joat_kill, heartbreak, jester_revenge (non-special case
    // below) all resolve to a plain loss — no side-win, game continues.
    return { state: nextState, events, followUpDeaths };
  }

  if (player.role === "jester") {
    if (category === "day_vote") {
      const eligibleTargets = votersAgainst ?? [];
      nextState = {
        ...nextState,
        sideWins: [
          ...nextState.sideWins,
          { playerId: player.id, role: "jester", reason: "day_vote", day: death.day },
        ],
      };
      return {
        state: nextState,
        events,
        followUpDeaths,
        enterJesterRevenge: { jesterId: player.id, eligibleTargets },
      };
    }
    // Any night-phase death (mafia/sk/vigilante/joat kill, or heartbreak):
    // Jester simply loses, game continues.
    return { state: nextState, events, followUpDeaths };
  }

  return { state: nextState, events, followUpDeaths };
}

/**
 * Special-cased: a Jester's revenge kill (from the jester_revenge_subphase)
 * targeting a Tanner voids both the Jester's just-recorded side-win and the
 * Tanner's usual side-win table — per the README, "both Tanner and the
 * Jester lose and are eliminated" in this specific interaction.
 */
export function voidJesterWinIfRevengeTargetIsTanner(
  state: GameState,
  jesterId: PlayerId,
  revengeTargetRole: string,
): GameState {
  if (revengeTargetRole !== "tanner") return state;
  return {
    ...state,
    sideWins: state.sideWins.filter((w) => w.playerId !== jesterId),
  };
}
