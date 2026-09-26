import type { PlayerView, ViewChatMessage, ViewPrivateLogEntry, ViewRosterEntry } from "./view-types.js";

/**
 * Shape of a raw `transcripts/*.json` dump (persist()'s output — the full
 * internal GameState, not a PlayerView). Only the fields the replay renderer
 * actually reads are declared; the real file has more (nightActions, votes,
 * rngState, etc.) that TypeScript's structural typing just ignores.
 */
export interface RawTranscript {
  phase: string;
  dayNumber: number;
  players: {
    id: string;
    displayName: string;
    alive: boolean;
    role: string;
    color?: string;
    icon?: string;
    /** The day their death resolved, if they're dead — undefined for a player who survived to the end. */
    deathDay?: number;
    /** @mafia/shared's DeathCause, e.g. "day_vote", "mafia_kill", "sk_kill:p3" — which phase within deathDay the death actually resolves in depends on this. */
    deathCause?: string;
  }[];
  chatLog: ViewChatMessage[];
  privateLog: ViewPrivateLogEntry[];
  setupConfig: { roleDistribution: Record<string, number> };
  winner?: { result: string; winningPlayerIds: string[] };
}

export const REPLAY_SPECTATOR_ID = "__replay_spectator__";

/**
 * A game still in progress has hidden roles — replaying it would reveal
 * every player's role and private-channel content to anyone watching the
 * video, including a player who's still mid-game in that same match. Only a
 * finished game (persist() runs after every command, so post_game
 * transcripts are always the true final state) is safe to turn into a
 * PlayerView with every role and channel exposed.
 */
export function validateReplayable(raw: unknown): raw is RawTranscript {
  const r = raw as Partial<RawTranscript> | null;
  if (!r || typeof r !== "object") return false;
  if (r.phase !== "post_game") return false;
  return Array.isArray(r.players) && Array.isArray(r.chatLog);
}

/**
 * @mafia/shared's real phase order within a day (see packages/shared/src/state.ts's
 * PHASES) — used to tell whether the replay has advanced *past* the point a
 * given death actually resolves, not just past its day number. Different
 * causes resolve in different phases of the same day: a night kill
 * (mafia_kill, sk_kill, vigilante_kill, joat_kill, tanner_boomerang)
 * resolves overnight and is announced at the start of day_discussion, but a
 * day_vote death doesn't resolve until day_vote itself concludes — treating
 * "any non-night phase of the death's day" as one blob (the original,
 * buggy version of this logic) showed a day-voted player as already dead
 * the moment day_discussion started, hours before the actual vote. Found
 * live: DeepSeek V4.1 (day_vote, day 1) showing dead right after Night 1's
 * actions, despite visibly participating in Day 1's discussion first.
 */
const PHASE_ORDER: Record<string, number> = {
  lobby: 0,
  night: 1,
  day_discussion: 2,
  day_vote: 3,
  jester_revenge_subphase: 4,
  debrief: 5,
  post_game: 6,
};

/** The phase a death of this cause actually resolves in — i.e., becomes visible once the replay moves past it. */
function deathBoundaryPhase(cause: string | undefined): string {
  if (cause === "day_vote") return "day_vote";
  if (cause === "jester_revenge") return "jester_revenge_subphase";
  // Everything else (mafia_kill, sk_kill:*, vigilante_kill:*, joat_kill,
  // tanner_boomerang) resolves overnight. heartbreak is a genuine
  // ambiguity — it fires the instant the paired partner dies, whatever
  // caused that — but a player's own record only has their own cause
  // ("heartbreak"), not their partner's; day_vote is the latest common
  // non-jester boundary, so defaulting here biases toward "still shown
  // alive a little longer than reality" rather than the spoiler direction
  // (dead before their own narrator line has actually been revealed).
  if (cause === "heartbreak") return "day_vote";
  return "night";
}

/**
 * Whether a player's death would already be visible to someone who has only
 * watched the replay up through `atDay`/`atPhase` — not whether they're
 * "dead" in the final transcript. See deathBoundaryPhase for why this needs
 * the death's cause, not just its day.
 */
function isDeadAsOf(deathDay: number | undefined, deathCause: string | undefined, atDay: number, atPhase: string): boolean {
  if (deathDay === undefined) return false;
  if (atDay > deathDay) return true;
  if (atDay < deathDay) return false;
  const boundary = PHASE_ORDER[deathBoundaryPhase(deathCause)] ?? 0;
  return (PHASE_ORDER[atPhase] ?? 0) > boundary;
}

/**
 * Roster with `alive` computed as of a specific point in the replay
 * (whichever message is currently on screen), not the transcript's final
 * state — see isDeadAsOf. Used by replay-main.ts to re-sync the scene after
 * every reveal, so players die progressively instead of spawning dead.
 */
export function rosterAsOf(raw: RawTranscript, atDay: number, atPhase: string): ViewRosterEntry[] {
  return raw.players.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    alive: !isDeadAsOf(p.deathDay, p.deathCause, atDay, atPhase),
    revealedRole: p.role,
    ...(p.color ? { color: p.color } : {}),
    ...(p.icon ? { icon: p.icon } : {}),
  }));
}

/**
 * Local equivalent of @mafia/engine's buildSpectatorView, restricted to the
 * post_game case only (validateReplayable already rejected anything else) —
 * so none of the "whose turn is it right now" logic that view applies for a
 * live game is needed here. Represents the transcript's *final* state —
 * replay-main.ts overrides dayNumber/phase/roster/winner progressively as
 * playback advances rather than using these values directly, so the HUD and
 * scene don't start already showing the ending.
 */
export function buildReplayView(raw: RawTranscript): PlayerView {
  return {
    playerId: REPLAY_SPECTATOR_ID,
    phase: raw.phase,
    dayNumber: raw.dayNumber,
    self: { role: "spectator", alignment: "neutral", alive: true },
    roster: rosterAsOf(raw, raw.dayNumber, raw.phase),
    visibleChannels: [...new Set(raw.chatLog.map((m) => m.channel))],
    chatLog: raw.chatLog,
    privateLog: raw.privateLog,
    pingCredits: 0,
    turnBudgets: [],
    ...(raw.winner ? { winner: raw.winner } : {}),
  };
}

/** Short id for compact display — matches how we've been referring to games by hash in conversation. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
