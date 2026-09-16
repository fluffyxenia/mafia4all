import type { Role } from "./roles.js";
import type { PlayerId } from "./channels.js";

export type RoleDistribution = Partial<Record<Role, number>>;

export interface Seat {
  playerId: PlayerId;
  displayName: string;
  /** CSS hex color (e.g. "#dd4b4b") for this player's avatar body in 3D clients. Omit to auto-assign from a default palette. */
  color?: string;
  /** Shown on this player's avatar's face in 3D clients: an image URL/path/data-URI, or (as a fallback) a single emoji/short glyph rendered as text. */
  icon?: string;
}

export interface TurnBudgetConfig {
  /**
   * Total messages per day in the town discussion channel, shared across
   * every player (not a per-player allowance) — found in real testing that
   * a fixed per-player cap scaled badly (12 players × 4-5 turns each = 48-60
   * total turns for one day, taking a long time to resolve, especially with
   * paid seats in the roster). A ping still grants the pinged player
   * priority to reply next (see dayPingQueue), but the reply itself still
   * draws from this same shared pool — pinging does not exempt anyone from
   * it once the pool is spent.
   */
  dayDiscussion: number;
  /** Messages per player per night in the mafia channel. */
  mafiaNight: number;
  /** Messages per player per night in the deep-divers channel. */
  deepDiverNight: number;
  /** Messages per player per night in their lovers channel. */
  loversNight: number;
}

export const DEFAULT_TURN_BUDGET_CONFIG: TurnBudgetConfig = {
  dayDiscussion: 20,
  mafiaNight: 6,
  deepDiverNight: 6,
  loversNight: 2,
};

export interface GameSetupConfig {
  seats: Seat[];
  roleDistribution: RoleDistribution;
  /** Pairs of playerIds to bind as lovers. Either player may hold any base role. */
  loverPairs?: [PlayerId, PlayerId][];
  turnBudgets?: Partial<TurnBudgetConfig>;
  /** Deterministic seed for role-shuffle RNG; omit for a random seed. */
  rngSeed?: number;
}
