import type { Alignment, JoatCharges, Role } from "./roles.js";
import type { ChannelId, PlayerId } from "./channels.js";
import type { GameSetupConfig } from "./config.js";

export const PHASES = [
  "lobby",
  "night",
  "day_discussion",
  "day_vote",
  "jester_revenge_subphase",
  "debrief",
  "post_game",
] as const;

export type Phase = (typeof PHASES)[number];

export type DeathCause =
  | "day_vote"
  | "mafia_kill"
  | `sk_kill:${PlayerId}`
  | `vigilante_kill:${PlayerId}`
  | "joat_kill"
  | "jester_revenge"
  | "heartbreak"
  /** Killing a Tanner boomerangs: the attacker(s) who did it are eliminated too. */
  | "tanner_boomerang";

export interface Player {
  id: PlayerId;
  displayName: string;
  role: Role;
  alignment: Alignment;
  alive: boolean;
  /** Cosmetic 3D-client avatar customization, carried through from the seat config. */
  color?: string;
  icon?: string;
  loverPairId?: string;
  joatCharges?: JoatCharges;
  /** Set once, when this player dies. */
  deathCause?: DeathCause;
  deathDay?: number;
}

export type SideWinReason = "day_vote" | "mafia_kill" | "sk_kill" | "jester_revenge_trigger";

export interface SideWin {
  playerId: PlayerId;
  role: Role;
  reason: SideWinReason;
  day: number;
}

/** Fixed author id for game-generated announcements (deaths, eliminations) — no player said these. */
export const NARRATOR_ID: PlayerId = "narrator";

export interface ChatMessage {
  id: string;
  channel: ChannelId;
  authorId: PlayerId;
  message: string;
  day: number;
  phase: Phase;
  /** Present if this message is a free-turn reply to a ping. */
  replyToPingId?: string;
  /** Present if this message is a ping targeting another player. */
  pingTargetId?: PlayerId;
  /** True for narrator-generated announcements rather than player-authored chat. */
  system?: boolean;
}

export interface PrivateLogEntry {
  /** The solo-role player this entry is visible to. */
  ownerId: PlayerId;
  day: number;
  text: string;
  kind?: "investigation" | "protection" | "kill_attempt" | "statement";
  targetId?: PlayerId;
  /** Structured result for programmatic use (e.g. "mafia" | "not-mafia" | "is-sk" | "not-sk"). */
  result?: string;
}

export type VoteTarget = PlayerId | "abstain" | "request_more_messages";

export interface Vote {
  voterId: PlayerId;
  target: VoteTarget;
  day: number;
  /** The voter's own stated reason, if they gave one. */
  reasoning?: string;
}

export interface NightActionRecord {
  actorId: PlayerId;
  actionType: string;
  targetId?: PlayerId;
  day: number;
  /** The actor's own stated reason, if they gave one. */
  reasoning?: string;
}

export interface DeathEvent {
  playerId: PlayerId;
  cause: DeathCause;
  day: number;
}

/** Per-player, per-channel-kind message counts for the *current* phase cycle. */
export interface TurnBudgetState {
  used: Record<PlayerId, Partial<Record<ChannelId, number>>>;
  /** Free-reply credits granted by a ping, consumed on next town-channel message. */
  pingCredits: Record<PlayerId, number>;
}

export interface PendingJesterRevenge {
  jesterId: PlayerId;
  eligibleTargets: PlayerId[];
  day: number;
}

export interface GameState {
  setupConfig: GameSetupConfig;
  phase: Phase;
  dayNumber: number;
  players: Player[];
  chatLog: ChatMessage[];
  privateLog: PrivateLogEntry[];
  votes: Vote[];
  nightActions: NightActionRecord[];
  deaths: DeathEvent[];
  sideWins: SideWin[];
  drawOutCounter: number;
  requestMoreMessagesUsedToday: boolean;
  turnBudgets: TurnBudgetState;
  pendingJesterRevenge?: PendingJesterRevenge;
  winner?: {
    result: "town" | "mafia" | "serial_killer" | "jester" | "tanner" | "draw_out";
    winningPlayerIds: PlayerId[];
  };
  rngState: number;
  /**
   * Day-discussion turn order: `dayTurnQueue` is the shuffled remaining
   * players for the current cycle (front = next up), reshuffled from
   * scratch whenever it empties (which includes the start of every new
   * day_discussion phase — the first "cycle" needs a shuffle too).
   * `dayPingQueue` holds players owed an immediate out-of-order reply from
   * being pinged, FIFO, and takes priority over `dayTurnQueue` while
   * non-empty. Both are irrelevant outside day_discussion.
   */
  dayTurnQueue: PlayerId[];
  dayPingQueue: PlayerId[];
  /**
   * The last player to speak in town chat (send_chat or a ping reply),
   * across any phase — kept around specifically so a fresh reshuffle at a
   * phase boundary (day_vote's "request more messages" back to
   * day_discussion, or night back to the next day_discussion) can avoid
   * putting them first again, the same way advanceDayTurn's mid-cycle
   * reshuffle already does. Undefined until anyone has spoken.
   */
  lastTownSpeakerId?: PlayerId;
  /**
   * day_vote turn order: every currently-alive player, shuffled once at the
   * day_discussion -> day_vote transition (front = next up). Unlike
   * dayTurnQueue, this needs no reshuffle-on-empty — voting is a single
   * pass, one vote per player, not a repeating multi-round cycle. Prevents
   * every AI seat's LLM firing simultaneously the instant day_vote begins.
   * Irrelevant outside day_vote.
   */
  dayVoteQueue: PlayerId[];
  /**
   * Turn order for every non-town chat channel (mafia, deep_divers, each
   * lovers pair) — same reshuffle-on-empty-cycle mechanism as
   * dayTurnQueue/dayPingQueue, just generalized across channels instead of
   * being town-specific. Originally these channels were "free-for-all,
   * budget-limited, no fairness concern to enforce" by design — found in
   * real testing to be a real problem, not a non-issue: a fast model could
   * burn its entire night-chat budget before a slower model in the same
   * channel got a single message in edgewise. Keyed by ChannelId; absent or
   * empty means no active cycle for that channel right now (channel not
   * writable this phase, or nobody currently eligible).
   */
  channelTurnQueues: Partial<Record<ChannelId, PlayerId[]>>;
  /**
   * The last player to speak in each non-town channel, across any phase —
   * same purpose as lastTownSpeakerId: lets a fresh per-night reshuffle
   * avoid opening with whoever closed out the previous night in that same
   * channel.
   */
  lastChannelSpeakerId: Partial<Record<ChannelId, PlayerId>>;
  /**
   * Post-game debrief turn order: every player who was ever seated, dead or
   * alive, in seat order (p1..pN — not shuffled, unlike every other queue
   * in this file), each owed exactly one final message once the game ends.
   * Single pass, no reshuffle-on-empty — once it drains, `debrief` advances
   * straight to the truly-terminal `post_game`. Populated by
   * `finalizeWinner`/`incrementDrawOut` in win-conditions.ts, the only two
   * places a game ends. Irrelevant outside `debrief`.
   */
  debriefQueue: PlayerId[];
}
