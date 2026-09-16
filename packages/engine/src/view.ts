import {
  isLoversChannel,
  loversChannel,
  type ChannelId,
  type ChatMessage,
  type GameState,
  type Phase,
  type Player,
  type PlayerId,
  type PrivateLogEntry,
  type Role,
} from "@mafia/shared";
import { canSendMessage, channelCap, totalTownUsed } from "./turn-budget.js";
import { currentDayTurn, currentVoteTurn } from "./day-turn-order.js";
import { currentDebriefTurn } from "./debrief.js";

export interface RosterEntry {
  id: PlayerId;
  displayName: string;
  alive: boolean;
  /** Only populated for self, living Mafia teammates, and (post-game) everyone. */
  revealedRole?: Role;
  color?: string;
  icon?: string;
}

export interface TurnBudgetView {
  channel: ChannelId;
  used: number;
  cap: number;
  canSend: boolean;
}

/** Sentinel playerId for a spectator's view — never a real seat, so it never matches a roster id (e.g. the "it's your turn" highlight). */
export const SPECTATOR_PLAYER_ID: PlayerId = "__spectator__";

export interface PlayerView {
  playerId: PlayerId;
  phase: Phase;
  dayNumber: number;
  self: {
    role: Role | "spectator";
    alignment: Player["alignment"];
    alive: boolean;
    loverPairId?: string;
    joatCharges?: Player["joatCharges"];
  };
  roster: RosterEntry[];
  visibleChannels: ChannelId[];
  chatLog: ChatMessage[];
  privateLog: PrivateLogEntry[];
  pingCredits: number;
  turnBudgets: TurnBudgetView[];
  /** Whose turn it is to speak in town chat right now (day_discussion only) — public info, same as the roster. */
  dayTurnPlayerId?: PlayerId;
  /** Whose turn it is to cast a vote right now (day_vote only) — public info, same as the roster. */
  dayVoteTurnPlayerId?: PlayerId;
  /** Whose turn it is to give their final word right now (debrief only) — public info, same as the roster. */
  debriefTurnPlayerId?: PlayerId;
  winner?: GameState["winner"];
}

function visibleChannelsFor(state: GameState, player: Player): ChannelId[] {
  const channels: ChannelId[] = ["town"];
  if (player.role === "mafia") channels.push("mafia");
  if (player.role === "deep_diver") channels.push("deep_divers");
  if (player.loverPairId) channels.push(loversChannel(player.loverPairId));
  return channels;
}

function channelVisibleToPlayer(channel: ChannelId, player: Player): boolean {
  if (channel === "town") return true;
  if (channel === "mafia") return player.role === "mafia";
  if (channel === "deep_divers") return player.role === "deep_diver";
  if (isLoversChannel(channel)) return channel === loversChannel(player.loverPairId ?? "");
  return false;
}

/**
 * Derives exactly what one player is allowed to see: their own role/state,
 * a redacted public roster, and only the chat/private-log entries for
 * channels they belong to. This is the actual security boundary the MCP
 * server's per-session resource filtering relies on.
 */
export function buildPlayerView(state: GameState, playerId: PlayerId): PlayerView {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`unknown player: ${playerId}`);

  // Roles/channels/logs are fully revealed once the game has ended — the
  // debrief itself depends on this (everyone needs to see the full board to
  // react to it), and post_game (reached once the debrief queue drains) is
  // just the same reveal with nothing left to do.
  const revealed = state.phase === "debrief" || state.phase === "post_game";

  const roster: RosterEntry[] = state.players.map((p) => {
    let revealedRole: Role | undefined;
    if (revealed || p.id === playerId) revealedRole = p.role;
    else if (player.role === "mafia" && player.alive && p.role === "mafia") revealedRole = p.role;
    return {
      id: p.id,
      displayName: p.displayName,
      alive: p.alive,
      ...(revealedRole ? { revealedRole } : {}),
      ...(p.color ? { color: p.color } : {}),
      ...(p.icon ? { icon: p.icon } : {}),
    };
  });

  const visibleChannels = revealed
    ? (["town", "mafia", "deep_divers", ...collectLoverChannels(state)] as ChannelId[])
    : visibleChannelsFor(state, player);

  const chatLog = revealed
    ? state.chatLog
    : state.chatLog.filter((m) => channelVisibleToPlayer(m.channel, player));

  const privateLog = revealed
    ? state.privateLog
    : state.privateLog.filter((e) => e.ownerId === playerId);

  const turnBudgets: TurnBudgetView[] = visibleChannels
    .filter((c) => !revealed)
    .map((channel) => {
      const cap = channelCap(state, channel);
      // A voluntary /pass records a large sentinel "used" value internally
      // to mean "no more turns this phase" — clamp it for display so it
      // never reads as having used more turns than the channel ever allowed.
      // Town's budget is a single pool shared by the whole table (see
      // totalTownUsed's doc comment), not a personal allowance — showing
      // this player's own count here read as "1/20" after 9 real messages
      // had already gone by, both misleading a human watching the HUD and
      // leaving every AI player thinking far more room was left in the
      // pool than actually was.
      const rawUsed = channel === "town" ? totalTownUsed(state) : (state.turnBudgets.used[playerId]?.[channel] ?? 0);
      const used = Math.min(rawUsed, cap);
      return { channel, used, cap, canSend: canSendMessage(state, playerId, channel) };
    });

  return {
    playerId,
    phase: state.phase,
    dayNumber: state.dayNumber,
    self: {
      role: player.role,
      alignment: player.alignment,
      alive: player.alive,
      ...(player.loverPairId ? { loverPairId: player.loverPairId } : {}),
      ...(player.joatCharges ? { joatCharges: player.joatCharges } : {}),
    },
    roster,
    visibleChannels,
    chatLog,
    privateLog,
    pingCredits: state.turnBudgets.pingCredits[playerId] ?? 0,
    turnBudgets,
    ...(state.phase === "day_discussion" && currentDayTurn(state)
      ? { dayTurnPlayerId: currentDayTurn(state) }
      : {}),
    ...(state.phase === "day_vote" && currentVoteTurn(state)
      ? { dayVoteTurnPlayerId: currentVoteTurn(state) }
      : {}),
    ...(state.phase === "debrief" && currentDebriefTurn(state)
      ? { debriefTurnPlayerId: currentDebriefTurn(state) }
      : {}),
    ...(state.winner ? { winner: state.winner } : {}),
  };
}

function collectLoverChannels(state: GameState): ChannelId[] {
  const pairIds = new Set(state.players.map((p) => p.loverPairId).filter(Boolean) as string[]);
  return [...pairIds].map(loversChannel);
}

/**
 * An omniscient, read-only view for a host/stream audience — every role
 * revealed and every channel visible regardless of phase, same as the
 * post-game reveal but available anytime. Deliberately shaped just like a
 * real PlayerView (with a sentinel playerId/self) so an existing player
 * client can render it with zero changes: no tools are ever advertised for
 * this session (see session.ts), so the action panel just stays empty.
 */
export function buildSpectatorView(state: GameState): PlayerView {
  const roster: RosterEntry[] = state.players.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    alive: p.alive,
    revealedRole: p.role,
    ...(p.color ? { color: p.color } : {}),
    ...(p.icon ? { icon: p.icon } : {}),
  }));

  return {
    playerId: SPECTATOR_PLAYER_ID,
    phase: state.phase,
    dayNumber: state.dayNumber,
    self: { role: "spectator", alignment: "neutral", alive: true },
    roster,
    visibleChannels: ["town", "mafia", "deep_divers", ...collectLoverChannels(state)] as ChannelId[],
    chatLog: state.chatLog,
    privateLog: state.privateLog,
    pingCredits: 0,
    turnBudgets: [],
    ...(state.phase === "day_discussion" && currentDayTurn(state)
      ? { dayTurnPlayerId: currentDayTurn(state) }
      : {}),
    ...(state.phase === "day_vote" && currentVoteTurn(state)
      ? { dayVoteTurnPlayerId: currentVoteTurn(state) }
      : {}),
    ...(state.phase === "debrief" && currentDebriefTurn(state)
      ? { debriefTurnPlayerId: currentDebriefTurn(state) }
      : {}),
    ...(state.winner ? { winner: state.winner } : {}),
  };
}
