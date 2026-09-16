/**
 * Local mirror of @mafia/engine's PlayerView shape (the CLI only ever sees
 * it as JSON off the wire, so it deliberately doesn't depend on @mafia/engine
 * — clients only depend on @mafia/shared and the MCP SDK, per the design doc).
 */
export interface CliChatMessage {
  id: string;
  channel: string;
  authorId: string;
  message: string;
  day: number;
  phase: string;
  pingTargetId?: string;
  system?: boolean;
}

export interface CliPrivateLogEntry {
  ownerId: string;
  day: number;
  text: string;
}

export interface CliRosterEntry {
  id: string;
  displayName: string;
  alive: boolean;
  revealedRole?: string;
}

export interface CliPlayerView {
  playerId: string;
  phase: string;
  dayNumber: number;
  self: {
    role: string;
    alignment: string;
    alive: boolean;
    loverPairId?: string;
    joatCharges?: Record<string, boolean>;
  };
  roster: CliRosterEntry[];
  visibleChannels: string[];
  chatLog: CliChatMessage[];
  privateLog: CliPrivateLogEntry[];
  pingCredits: number;
  turnBudgets: { channel: string; used: number; cap: number; canSend: boolean }[];
  dayTurnPlayerId?: string;
  winner?: { result: string; winningPlayerIds: string[] };
}
