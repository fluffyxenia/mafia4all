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

/** Creates a fresh game in the 'lobby' phase. Roles are not assigned until start_game. */
export function createGame(config: GameSetupConfig): GameState {
  const roster = expandRoster(config.roleDistribution);
  if (roster.length !== config.seats.length) {
    throw new Error(
      `role distribution has ${roster.length} roles but there are ${config.seats.length} seats`,
    );
  }

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
    rngState: config.rngSeed ?? Date.now(),
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

  const { result: roster, nextSeed } = shuffleWithState(
    expandRoster(state.setupConfig.roleDistribution),
    state.rngState,
  );

  const players: Player[] = state.players.map((player, i) => {
    const role = roster[i]!;
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
