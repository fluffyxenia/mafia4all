import { describe, expect, it } from "vitest";
import { evaluateWinConditions } from "../win-conditions.js";
import { seat, testState } from "./test-helpers.js";

describe("evaluateWinConditions", () => {
  it("Town wins once every hostile threat is gone", () => {
    const state = testState([seat("a", "town"), seat("b", "sheriff")]);
    const { state: next } = evaluateWinConditions(state);
    expect(next.winner).toEqual({ result: "town", winningPlayerIds: ["a", "b"] });
    // A decided game moves into the debrief, not straight to post_game — see debrief.test.ts.
    expect(next.phase).toBe("debrief");
    expect(next.debriefQueue).toEqual(["a", "b"]);
  });

  it("seeds the debrief queue with every seated player in original seat order, including the dead", () => {
    const state = testState([
      seat("a", "town", { alive: false }),
      seat("b", "mafia", { alive: false }),
      seat("c", "town"),
    ]);
    const { state: next } = evaluateWinConditions(state);
    expect(next.winner?.result).toBe("town");
    expect(next.debriefQueue).toEqual(["a", "b", "c"]);
  });

  it("Town loses once hostiles equal or outnumber town-aligned survivors", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia"), seat("c", "serial_killer")]);
    const { state: next } = evaluateWinConditions(state);
    expect(next.winner?.result).toBe("mafia");
    expect(next.winner?.winningPlayerIds.sort()).toEqual(["b", "c"]);
  });

  it("Mafia wins once every non-Mafia-aligned player is gone", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia")]);
    const { state: next } = evaluateWinConditions(state);
    expect(next.winner).toEqual({ result: "mafia", winningPlayerIds: ["a", "b"] });
  });

  it("Serial Killer wins by being the sole survivor", () => {
    const state = testState([seat("sk", "serial_killer")]);
    const { state: next } = evaluateWinConditions(state);
    expect(next.winner).toEqual({ result: "serial_killer", winningPlayerIds: ["sk"] });
  });

  it("does not re-evaluate once a winner is already set", () => {
    const state = testState([seat("a", "town")], {
      winner: { result: "town", winningPlayerIds: ["a"] },
    });
    const { events } = evaluateWinConditions(state);
    expect(events).toHaveLength(0);
  });

  it("neither Jester nor Tanner count toward the Town/hostile tally", () => {
    const state = testState([
      seat("a", "town"),
      seat("b", "mafia"),
      seat("jester", "jester"),
      seat("tanner", "tanner"),
    ]);
    const { state: next } = evaluateWinConditions(state);
    // 1 town-aligned vs 1 hostile -> Town loses, regardless of the two neutrals alive.
    expect(next.winner?.result).toBe("mafia");
  });
});
