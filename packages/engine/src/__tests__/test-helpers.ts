import {
  ROLE_ALIGNMENT,
  initialJoatCharges,
  type GameSetupConfig,
  type GameState,
  type Player,
  type Role,
} from "@mafia/shared";

export function seat(id: string, role: Role, extra: Partial<Player> = {}): Player {
  return {
    id,
    displayName: id,
    role,
    alignment: ROLE_ALIGNMENT[role],
    alive: true,
    ...(role === "jack_of_all_trades" ? { joatCharges: initialJoatCharges() } : {}),
    ...extra,
  };
}

export function testState(players: Player[], overrides: Partial<GameState> = {}): GameState {
  const setupConfig: GameSetupConfig = {
    seats: players.map((p) => ({ playerId: p.id, displayName: p.displayName })),
    roleDistribution: {},
  };
  return {
    setupConfig,
    phase: "night",
    dayNumber: 1,
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
    rngState: 1,
    dayTurnQueue: [],
    dayPingQueue: [],
    dayVoteQueue: [],
    channelTurnQueues: {},
    lastChannelSpeakerId: {},
    debriefQueue: [],
    ...overrides,
  };
}
