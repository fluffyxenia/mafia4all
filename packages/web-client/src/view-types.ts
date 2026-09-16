/**
 * Local mirror of @mafia/engine's PlayerView shape (seen only as JSON off
 * the wire). Kept independent of @mafia/engine for the same reason as the
 * other clients: this package only depends on @mafia/shared-shaped wire
 * data and the MCP SDK, not the engine itself.
 */
export interface ViewChatMessage {
  id: string;
  channel: string;
  authorId: string;
  message: string;
  day: number;
  phase: string;
  pingTargetId?: string;
  system?: boolean;
}

export interface ViewPrivateLogEntry {
  ownerId: string;
  day: number;
  text: string;
}

export interface ViewRosterEntry {
  id: string;
  displayName: string;
  alive: boolean;
  revealedRole?: string;
  color?: string;
  icon?: string;
}

export interface PlayerView {
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
  roster: ViewRosterEntry[];
  visibleChannels: string[];
  chatLog: ViewChatMessage[];
  privateLog: ViewPrivateLogEntry[];
  pingCredits: number;
  turnBudgets: { channel: string; used: number; cap: number; canSend: boolean }[];
  dayTurnPlayerId?: string;
  dayVoteTurnPlayerId?: string;
  debriefTurnPlayerId?: string;
  winner?: { result: string; winningPlayerIds: string[] };
}
