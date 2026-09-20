/**
 * Local mirror of @mafia/engine's PlayerView shape (seen only as JSON off
 * the wire). Kept independent of @mafia/engine for the same reason as
 * cli-client: clients only depend on @mafia/shared and the MCP SDK.
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
  /** Role-count breakdown for this game (e.g. `{mafia: 3, town: 6, ...}`) — which roles exist and how many, not who has which. */
  roleDistribution: Record<string, number>;
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
