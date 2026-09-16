import { describe, expect, it } from "vitest";
import type { GameState } from "@mafia/shared";
import { applyCommand } from "../reducer.js";
import { tryAdvancePhase } from "../advance.js";
import { createGame } from "../setup.js";
import { currentDayTurn, currentVoteTurn } from "../day-turn-order.js";
import { currentDebriefTurn } from "../debrief.js";

function drainAdvances(state: GameState): GameState {
  let current = state;
  for (let i = 0; i < 10; i++) {
    const result = tryAdvancePhase(current);
    if (!result) return current;
    current = result.state;
  }
  return current;
}

function must(result: ReturnType<typeof applyCommand>): GameState {
  if (!result.ok) throw new Error(`command failed: ${result.error}`);
  return result.state;
}

/**
 * day_discussion has no pass (see tool-availability.ts) — the phase keeps
 * going until town's shared message pool (see turn-budget.ts) is spent.
 * Speaks as whoever is actually up each time, since turn order is
 * randomized per game.
 *
 * Checks readiness *before* trusting currentDayTurn on every iteration,
 * mirroring GameRuntime's own auto-advance-after-every-command behavior —
 * required now that town's cap is a pool shared across every player rather
 * than a per-player allowance: the pool can run out mid-round, partway
 * through an already-built dayTurnQueue, leaving queue entries for players
 * who technically can't send anymore. GameRuntime never hits this because
 * it re-checks tryAdvancePhase after every single command; raw
 * applyCommand (used here) doesn't do that automatically, so this loop has
 * to.
 */
function exhaustDayDiscussion(state: GameState): GameState {
  let current = state;
  while (current.phase === "day_discussion") {
    const advanced = tryAdvancePhase(current);
    if (advanced) {
      current = advanced.state;
      continue;
    }
    const turnId = currentDayTurn(current);
    if (!turnId) throw new Error("day_discussion stuck: no current turn and unable to advance");
    current = must(
      applyCommand(current, { type: "send_chat", playerId: turnId, channel: "town", message: "Nothing new from me yet." }),
    );
  }
  return current;
}

/**
 * day_vote is sequential too (see tool-availability.ts) — casts each
 * player's designated vote whenever the state says it's actually their
 * turn, regardless of the map's key order, since turn order is randomized.
 */
function castVotesInOrder(state: GameState, votesByPlayerId: Record<string, string>): GameState {
  let current = state;
  while (current.phase === "day_vote") {
    const turnId = currentVoteTurn(current);
    if (!turnId) break;
    current = must(applyCommand(current, { type: "cast_vote", playerId: turnId, target: votesByPlayerId[turnId]! }));
  }
  return current;
}

/** Gives every seated player (dead or alive) their one debrief message, in queue order. */
function exhaustDebrief(state: GameState): GameState {
  let current = state;
  while (current.phase === "debrief") {
    const turnId = currentDebriefTurn(current);
    if (!turnId) throw new Error("debrief stuck: no current turn");
    current = must(
      applyCommand(current, { type: "send_chat", playerId: turnId, channel: "town", message: "GG, well played." }),
    );
    const advanced = tryAdvancePhase(current);
    if (advanced) current = advanced.state;
  }
  return current;
}

describe("full game flow (reducer + advance wiring)", () => {
  it("plays night -> day_discussion -> day_vote -> Town win end to end", () => {
    let state = createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
        { playerId: "p4", displayName: "P4" },
      ],
      roleDistribution: { mafia: 1, sheriff: 1, doctor: 1, town: 1 },
      turnBudgets: { dayDiscussion: 1 },
      rngSeed: 1,
    });

    state = must(applyCommand(state, { type: "start_game" }));
    expect(state.phase).toBe("night");

    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const sheriffId = state.players.find((p) => p.role === "sheriff")!.id;
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    // Doctor protects the town player mafia is about to target; the kill fails silently.
    state = must(
      applyCommand(state, { type: "night_action", playerId: doctorId, actionType: "doctor_protect", targetPlayerId: townId }),
    );
    state = must(
      applyCommand(state, { type: "night_action", playerId: mafiaId, actionType: "mafia_kill_proposal", targetPlayerId: townId }),
    );
    state = must(
      applyCommand(state, { type: "night_action", playerId: sheriffId, actionType: "sheriff_investigate", targetPlayerId: mafiaId }),
    );

    state = drainAdvances(state);
    expect(state.phase).toBe("day_discussion");
    expect(state.players.find((p) => p.id === townId)!.alive).toBe(true);
    const sheriffLog = state.privateLog.find((l) => l.ownerId === sheriffId && l.kind === "investigation");
    expect(sheriffLog?.result).toBe("mafia");

    state = exhaustDayDiscussion(state);
    state = drainAdvances(state);
    expect(state.phase).toBe("day_vote");

    state = castVotesInOrder(state, {
      [sheriffId]: mafiaId,
      [doctorId]: mafiaId,
      [townId]: mafiaId,
      [mafiaId]: "abstain",
    });

    state = drainAdvances(state);
    expect(state.phase).toBe("debrief");
    expect(state.winner?.result).toBe("town");
    expect(state.players.find((p) => p.id === mafiaId)!.alive).toBe(false);
    // Every seated player, including the now-dead mafiaId, owes a final word.
    expect(new Set(state.debriefQueue)).toEqual(new Set([sheriffId, doctorId, townId, mafiaId]));

    state = exhaustDebrief(state);
    expect(state.phase).toBe("post_game");
    expect(state.debriefQueue).toHaveLength(0);
  });

  it("rejects a doctor targeting the same player a second time across nights", () => {
    // Includes a Mafia seat so the game doesn't trivially end as an
    // immediate Town win (hostile count already zero) before night 2.
    let state = createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
      ],
      roleDistribution: { doctor: 1, town: 1, mafia: 1 },
      turnBudgets: { dayDiscussion: 1 },
      rngSeed: 2,
    });
    state = must(applyCommand(state, { type: "start_game" }));
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;

    const first = applyCommand(state, {
      type: "night_action",
      playerId: doctorId,
      actionType: "doctor_protect",
      targetPlayerId: townId,
    });
    expect(first.ok).toBe(true);
    state = must(first);
    state = must(applyCommand(state, { type: "pass", playerId: mafiaId }));

    // Force the night to resolve, then simulate a second night's attempt on the same target.
    state = drainAdvances(state);
    expect(state.phase).toBe("day_discussion");
    state = exhaustDayDiscussion(state);
    state = drainAdvances(state);
    expect(state.phase).toBe("day_vote");
    state = castVotesInOrder(state, { [doctorId]: "abstain", [townId]: "abstain", [mafiaId]: "abstain" });
    state = drainAdvances(state);
    expect(state.phase).toBe("night");

    const second = applyCommand(state, {
      type: "night_action",
      playerId: doctorId,
      actionType: "doctor_protect",
      targetPlayerId: townId,
    });
    expect(second.ok).toBe(false);
  });
});
