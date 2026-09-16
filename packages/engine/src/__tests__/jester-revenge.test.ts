import { describe, expect, it } from "vitest";
import { resolveJesterRevenge } from "../resolution/jester-revenge.js";
import { seat, testState } from "./test-helpers.js";

function subphaseState(extraPlayers: ReturnType<typeof seat>[] = []) {
  return testState(
    [
      seat("jester", "jester", { alive: false, deathCause: "day_vote", deathDay: 1 }),
      seat("accuser1", "town"),
      seat("accuser2", "mafia"),
      // Bystanders keep the board from accidentally flipping a numeric
      // Town/Mafia win once an accuser dies, which isn't what these tests
      // are checking.
      seat("bystander1", "town"),
      seat("bystander2", "town"),
      ...extraPlayers,
    ],
    {
      phase: "jester_revenge_subphase",
      dayNumber: 1,
      pendingJesterRevenge: { jesterId: "jester", eligibleTargets: ["accuser1", "accuser2"], day: 1 },
      sideWins: [{ playerId: "jester", role: "jester", reason: "day_vote", day: 1 }],
    },
  );
}

describe("resolveJesterRevenge", () => {
  it("kills the chosen accuser and clears the pending revenge", () => {
    const state = subphaseState();
    const { state: next } = resolveJesterRevenge(state, "accuser1");
    expect(next.players.find((p) => p.id === "accuser1")!.alive).toBe(false);
    expect(next.pendingJesterRevenge).toBeUndefined();
    expect(next.phase).toBe("night");
    expect(next.dayNumber).toBe(2);
    // Regression: this transition into a new night used to leave
    // channelTurnQueues stale/unseeded, same class of bug as the day-vote
    // transition — mafia's surviving member would be locked out of their
    // own team chat for the rest of the game.
    expect(next.channelTurnQueues.mafia).toEqual(["accuser2"]);
  });

  it("declining revenge (no target) still moves the game on", () => {
    const state = subphaseState();
    const { state: next } = resolveJesterRevenge(state, undefined);
    expect(next.players.every((p) => p.id === "jester" || p.alive)).toBe(true);
    expect(next.phase).toBe("night");
  });

  it("the Jester's side-win still stands when the revenge target is not a Tanner", () => {
    const state = subphaseState();
    const { state: next } = resolveJesterRevenge(state, "accuser1");
    expect(next.sideWins).toContainEqual(
      expect.objectContaining({ playerId: "jester", role: "jester" }),
    );
  });

  it("revenge-killing a Tanner voids both the Jester's and the Tanner's win", () => {
    // accuser4 keeps the board from also flipping a numeric Town win/loss
    // out from under this assertion once the Tanner dies.
    const state = subphaseState([seat("accuser3", "tanner"), seat("accuser4", "town")]);
    const withTanner = {
      ...state,
      pendingJesterRevenge: {
        jesterId: "jester",
        eligibleTargets: ["accuser1", "accuser2", "accuser3"],
        day: 1,
      },
    };
    const { state: next } = resolveJesterRevenge(withTanner, "accuser3");
    expect(next.players.find((p) => p.id === "accuser3")!.alive).toBe(false);
    expect(next.sideWins.find((w) => w.playerId === "jester")).toBeUndefined();
    expect(next.sideWins.find((w) => w.playerId === "accuser3")).toBeUndefined();
    expect(next.winner).toBeUndefined();
  });
});
