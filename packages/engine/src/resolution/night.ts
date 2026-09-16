import type {
  DeathCause,
  GameEvent,
  GameState,
  NightActionRecord,
  Player,
  PlayerId,
  PrivateLogEntry,
} from "@mafia/shared";
import { processDeaths, type PendingDeath } from "./apply-deaths.js";
import { appendNarratorMessage } from "../narrator.js";
import { displayNameOf } from "../flavor.js";

interface KillAttempt {
  actorId: PlayerId;
  targetId: PlayerId;
  cause: DeathCause;
}

function actionsFor(state: GameState, actionType: string): NightActionRecord[] {
  return state.nightActions.filter((a) => a.day === state.dayNumber && a.actionType === actionType);
}

function plurality(votes: PlayerId[]): PlayerId | undefined {
  if (votes.length === 0) return undefined;
  const counts = new Map<PlayerId, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  let winner: PlayerId | undefined;
  let winnerCount = 0;
  let tied = false;
  for (const [id, count] of counts) {
    if (count > winnerCount) {
      winner = id;
      winnerCount = count;
      tied = false;
    } else if (count === winnerCount) {
      tied = true;
    }
  }
  return tied ? undefined : winner;
}

/**
 * Runs the full night-action resolution pipeline for the current night:
 * protections, then investigations, then simultaneous kills (protected
 * targets fail silently). Returns the resulting state after cascading any
 * deaths (heartbreak, Tanner/Jester outcomes, win-condition checks).
 */
export function resolveNight(state: GameState): { state: GameState; events: GameEvent[] } {
  let nextState = state;
  const day = state.dayNumber;
  const newLogEntries: PrivateLogEntry[] = [];

  // 1. Protections resolve first — union of all protect targets this night.
  const protectActions = [...actionsFor(state, "doctor_protect"), ...actionsFor(state, "joat_protect")];
  const protectedTargets = new Set(protectActions.map((a) => a.targetId).filter(Boolean) as PlayerId[]);
  for (const action of protectActions) {
    newLogEntries.push({
      ownerId: action.actorId,
      day,
      kind: "protection",
      targetId: action.targetId,
      result: "protected",
      text: `You protected ${displayNameOf(state, action.targetId!)} tonight.`,
    });
  }

  // 2. Investigations resolve next — read-only, against pre-resolution roles.
  const investigate = (
    actionType: "sheriff_investigate" | "deep_diver_investigate" | "joat_investigate",
    resultFor: (target: Player | undefined) => string,
  ) => {
    for (const action of actionsFor(state, actionType)) {
      const target = state.players.find((p) => p.id === action.targetId);
      const result = resultFor(target);
      newLogEntries.push({
        ownerId: action.actorId,
        day,
        kind: "investigation",
        targetId: action.targetId,
        result,
        text: `You investigated ${displayNameOf(state, action.targetId!)}: ${result}.`,
      });
    }
  };
  investigate("sheriff_investigate", (t) => (t?.role === "mafia" ? "mafia" : "not-mafia"));
  investigate("deep_diver_investigate", (t) => (t?.role === "serial_killer" ? "is-sk" : "not-sk"));
  investigate("joat_investigate", (t) => (t?.role === "mafia" ? "mafia" : "not-mafia"));

  // 3. Kills resolve simultaneously.
  const killAttempts: KillAttempt[] = [];

  const mafiaProposals = actionsFor(state, "mafia_kill_proposal")
    .map((a) => a.targetId)
    .filter(Boolean) as PlayerId[];
  const mafiaTarget = plurality(mafiaProposals);
  if (mafiaTarget) {
    for (const action of actionsFor(state, "mafia_kill_proposal")) {
      killAttempts.push({ actorId: action.actorId, targetId: mafiaTarget, cause: "mafia_kill" });
    }
  }

  for (const action of actionsFor(state, "sk_kill")) {
    if (!action.targetId) continue;
    killAttempts.push({
      actorId: action.actorId,
      targetId: action.targetId,
      cause: `sk_kill:${action.actorId}`,
    });
  }

  for (const action of actionsFor(state, "vigilante_kill")) {
    if (!action.targetId) continue;
    killAttempts.push({
      actorId: action.actorId,
      targetId: action.targetId,
      cause: `vigilante_kill:${action.actorId}`,
    });
  }

  for (const action of actionsFor(state, "joat_eliminate")) {
    if (!action.targetId) continue;
    killAttempts.push({ actorId: action.actorId, targetId: action.targetId, cause: "joat_kill" });
  }

  const deaths: PendingDeath[] = [];
  const seenAttackers = new Set<PlayerId>();
  for (const attempt of killAttempts) {
    // Mafia's shared kill only produces one log per member, already deduped by attempt.
    const attemptKey = `${attempt.actorId}:${attempt.cause}`;
    if (seenAttackers.has(attemptKey)) continue;
    seenAttackers.add(attemptKey);

    if (protectedTargets.has(attempt.targetId)) {
      newLogEntries.push({
        ownerId: attempt.actorId,
        day,
        kind: "kill_attempt",
        targetId: attempt.targetId,
        result: "nothing_happened",
        text: `Nothing happened to ${displayNameOf(state, attempt.targetId)} last night.`,
      });
      continue;
    }
    newLogEntries.push({
      ownerId: attempt.actorId,
      day,
      kind: "kill_attempt",
      targetId: attempt.targetId,
      result: "success",
      text: `${displayNameOf(state, attempt.targetId)} was eliminated last night.`,
    });
    deaths.push({ playerId: attempt.targetId, cause: attempt.cause });
  }

  nextState = { ...nextState, privateLog: [...nextState.privateLog, ...newLogEntries] };
  nextState = spendJoatCharges(nextState);

  const result = processDeaths(nextState, deaths, day);
  nextState = result.state;

  // Morning-after announcement in town chat: the whole point of surfacing
  // reasoning/statements elsewhere is moot if nobody can even see who died.
  // Announced even if this death also just ended the game — that's the
  // moment it matters most, not less.
  const tonightDeaths = nextState.deaths.filter((d) => d.day === day);
  if (tonightDeaths.length === 0) {
    nextState = appendNarratorMessage(nextState, "town", "Nobody died last night.", day, "day_discussion");
  } else {
    for (const death of tonightDeaths) {
      const name = displayNameOf(state, death.playerId);
      const text =
        death.cause === "heartbreak" ? `${name} could not bear the loss and dies of heartbreak.` : `${name} was found dead this morning.`;
      nextState = appendNarratorMessage(nextState, "town", text, day, "day_discussion");
    }
  }

  return { state: nextState, events: result.events };
}

/** JoAT's three tools are one-shot: burn the charge once the action actually resolves. */
function spendJoatCharges(state: GameState): GameState {
  const spent = new Map<PlayerId, "investigate" | "protect" | "eliminate">();
  for (const a of actionsFor(state, "joat_investigate")) spent.set(a.actorId, "investigate");
  for (const a of actionsFor(state, "joat_protect")) spent.set(a.actorId, "protect");
  for (const a of actionsFor(state, "joat_eliminate")) spent.set(a.actorId, "eliminate");
  if (spent.size === 0) return state;
  return {
    ...state,
    players: state.players.map((p) => {
      const key = spent.get(p.id);
      if (!key || !p.joatCharges) return p;
      return { ...p, joatCharges: { ...p.joatCharges, [key]: false } };
    }),
  };
}
