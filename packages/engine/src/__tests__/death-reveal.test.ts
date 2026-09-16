import { describe, expect, it } from "vitest";
import { processDeaths } from "../resolution/apply-deaths.js";
import { seat, testState } from "./test-helpers.js";

describe("processDeaths: Mafia-association reveal", () => {
  it("announces a Mafia death as such, in town chat", () => {
    const state = testState([seat("a", "mafia"), seat("b", "town"), seat("c", "town")]);
    const { state: next } = processDeaths(state, [{ playerId: "a", cause: "day_vote" }], 1);
    const reveal = next.chatLog.find((m) => m.system && m.message.includes("Mafia"));
    expect(reveal?.message).toBe("a was Mafia.");
    expect(reveal?.channel).toBe("town");
  });

  it("announces a non-Mafia death as such", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia"), seat("c", "town")]);
    const { state: next } = processDeaths(state, [{ playerId: "a", cause: "day_vote" }], 1);
    const reveal = next.chatLog.find((m) => m.system && m.message.includes("Mafia"));
    expect(reveal?.message).toBe("a was not Mafia.");
  });

  it("reveals a heartbreak-cascade death too, not just the death that triggered it", () => {
    // Regression: placed in the shared apply-deaths.ts drain loop
    // specifically so a cascade death (heartbreak, boomerang) that a
    // resolution file's own announcement might not separately call out
    // still gets its own reveal.
    const withPairs = testState([
      seat("a", "town", { loverPairId: "pair0" }),
      seat("b", "mafia", { loverPairId: "pair0" }),
      seat("c", "town"),
    ]);
    const { state: next } = processDeaths(withPairs, [{ playerId: "a", cause: "day_vote" }], 1);
    const reveals = next.chatLog.filter((m) => m.system && m.message.includes("Mafia")).map((m) => m.message);
    expect(reveals).toContain("a was not Mafia.");
    expect(reveals).toContain("b was Mafia.");
    expect(next.players.find((p) => p.id === "b")!.alive).toBe(false);
  });
});
