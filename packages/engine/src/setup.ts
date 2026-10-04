import { randomInt } from "node:crypto";
import {
  DEFAULT_TURN_BUDGET_CONFIG,
  ROLE_ALIGNMENT,
  initialJoatCharges,
  type GameSetupConfig,
  type GameState,
  type Player,
  type Role,
} from "@mafia/shared";
import { shuffleWithState } from "./rng.js";
import { initializeChannelTurnQueuesForNight } from "./channel-turn-order.js";

function expandRoster(distribution: GameSetupConfig["roleDistribution"]): Role[] {
  const roster: Role[] = [];
  for (const [role, count] of Object.entries(distribution) as [Role, number | undefined][]) {
    for (let i = 0; i < (count ?? 0); i++) {
      roster.push(role);
    }
  }
  return roster;
}

/**
 * Validates that every seat's `pinnedRole` (if any) can actually be honored
 * — each role's pinned count can't exceed that role's count in
 * `roleDistribution`. Called at both `createGame` (so a host sees a bad pin
 * immediately, not only once they click Start) and `assignRolesAndStart`
 * (defensive — setupConfig is otherwise immutable by then, but this stays
 * cheap and correct even if that ever changes).
 */
function validatePinnedRoles(config: GameSetupConfig): void {
  const pinnedCounts: Partial<Record<Role, number>> = {};
  for (const seat of config.seats) {
    if (!seat.pinnedRole) continue;
    pinnedCounts[seat.pinnedRole] = (pinnedCounts[seat.pinnedRole] ?? 0) + 1;
  }
  for (const [role, pinned] of Object.entries(pinnedCounts) as [Role, number][]) {
    const available = config.roleDistribution[role] ?? 0;
    if (pinned > available) {
      throw new Error(
        `${pinned} seat(s) pinned to role '${role}', but roleDistribution only allocates ${available}`,
      );
    }
  }
}

/** Creates a fresh game in the 'lobby' phase. Roles are not assigned until start_game. */
export function createGame(config: GameSetupConfig): GameState {
  const roster = expandRoster(config.roleDistribution);
  if (roster.length !== config.seats.length) {
    throw new Error(
      `role distribution has ${roster.length} roles but there are ${config.seats.length} seats`,
    );
  }
  validatePinnedRoles(config);

  const players: Player[] = config.seats.map((seat) => ({
    id: seat.playerId,
    displayName: seat.displayName,
    role: "town",
    alignment: "town",
    alive: true,
    ...(seat.color ? { color: seat.color } : {}),
    ...(seat.icon ? { icon: seat.icon } : {}),
  }));

  return {
    setupConfig: config,
    phase: "lobby",
    dayNumber: 0,
    players,
    chatLog: [],
    privateLog: [],
    votes: [],
    nightActions: [],
    deaths: [],
    sideWins: [],
    drawOutCounter: 0,
    requestMoreMessagesUsedToday: false,
    turnBudgets: { used: {}, pingCredits: {} },
    // `Date.now()` was the previous fallback here, but two games created
    // within the same millisecond (observed live: a tight loop, but also a
    // real risk from any fast back-to-back game creation) got the exact same
    // seed and therefore an identical role shuffle — not the independent
    // random draw each game is supposed to get. `crypto.randomInt` has no
    // such collision risk at this timescale.
    rngState: config.rngSeed ?? randomInt(0, 0x100000000),
    dayTurnQueue: [],
    dayPingQueue: [],
    dayVoteQueue: [],
    channelTurnQueues: {},
    lastChannelSpeakerId: {},
    debriefQueue: [],
  };
}

/**
 * Assigns roles and lover pairs, then transitions from 'lobby' into the
 * first night phase. Pure — returns a new state, does not mutate the input.
 */
export function assignRolesAndStart(state: GameState): GameState {
  if (state.phase !== "lobby") {
    throw new Error(`cannot start game from phase '${state.phase}'`);
  }
  validatePinnedRoles(state.setupConfig);

  // Pull one instance out of the pool per pinned seat first, then shuffle
  // only what's left — so a pin is honored exactly, and every unpinned seat
  // still draws uniformly at random from whatever roles remain.
  const pool = expandRoster(state.setupConfig.roleDistribution);
  const seatsByPlayerId = new Map(state.setupConfig.seats.map((seat) => [seat.playerId, seat]));
  for (const player of state.players) {
    const pinnedRole = seatsByPlayerId.get(player.id)?.pinnedRole;
    if (!pinnedRole) continue;
    const idx = pool.indexOf(pinnedRole);
    pool.splice(idx, 1);
  }

  const { result: shuffledRemainder, nextSeed } = shuffleWithState(pool, state.rngState);

  let nextUnpinnedIdx = 0;
  const players: Player[] = state.players.map((player) => {
    const pinnedRole = seatsByPlayerId.get(player.id)?.pinnedRole;
    const role = pinnedRole ?? shuffledRemainder[nextUnpinnedIdx++]!;
    const loverPairId = findLoverPairId(state.setupConfig.loverPairs, player.id);
    return {
      ...player,
      role,
      alignment: ROLE_ALIGNMENT[role],
      joatCharges: role === "jack_of_all_trades" ? initialJoatCharges() : undefined,
      ...(loverPairId ? { loverPairId } : {}),
    };
  });

  const started: GameState = {
    ...state,
    players,
    phase: "night",
    dayNumber: 1,
    turnBudgets: { used: {}, pingCredits: {} },
    rngState: nextSeed,
    dayTurnQueue: [],
    dayPingQueue: [],
    dayVoteQueue: [],
    channelTurnQueues: {},
  };
  return initializeChannelTurnQueuesForNight(started);
}

function findLoverPairId(
  loverPairs: GameSetupConfig["loverPairs"],
  playerId: string,
): string | undefined {
  if (!loverPairs) return undefined;
  const idx = loverPairs.findIndex((pair) => pair.includes(playerId));
  if (idx === -1) return undefined;
  return `pair${idx}`;
}

export function turnBudgetConfig(state: GameState) {
  return { ...DEFAULT_TURN_BUDGET_CONFIG, ...state.setupConfig.turnBudgets };
}
