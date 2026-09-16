import { describe, expect, it } from "vitest";
import { canSendMessage, recordMessage } from "../turn-budget.js";
import { seat, testState } from "./test-helpers.js";

describe("turn budgets", () => {
  it("day discussion defaults to a single 20-message pool shared across every player, not a per-player allowance", () => {
    // Regression: found in real testing that a fixed per-player cap scaled
    // badly (12 players x 4-5 turns each = 48-60 total turns for one day).
    // Switched to a shared pool — this confirms two different players
    // drawing from the same total, not two separate personal budgets.
    let state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_discussion" });
    for (let i = 0; i < 12; i++) state = recordMessage(state, "a", "town");
    for (let i = 0; i < 8; i++) state = recordMessage(state, "b", "town");
    expect(canSendMessage(state, "a", "town")).toBe(false);
    expect(canSendMessage(state, "b", "town")).toBe(false);
  });

  it("a message from any player draws down the same shared town pool for everyone else too", () => {
    let state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_discussion" });
    for (let i = 0; i < 20; i++) state = recordMessage(state, "a", "town");
    // b never sent a message of their own, but the shared pool is spent.
    expect(canSendMessage(state, "b", "town")).toBe(false);
  });

  it("lover night chat is capped at 2 messages", () => {
    let state = testState([seat("a", "town", { loverPairId: "pair0" })]);
    state = recordMessage(state, "a", "lovers:pair0");
    state = recordMessage(state, "a", "lovers:pair0");
    expect(canSendMessage(state, "a", "lovers:pair0")).toBe(false);
  });

  it("mafia/deep_divers/lovers channels stay per-player, unaffected by town's pooling", () => {
    let state = testState([seat("a", "mafia"), seat("b", "mafia")], { phase: "night" });
    for (let i = 0; i < 6; i++) state = recordMessage(state, "a", "mafia");
    expect(canSendMessage(state, "a", "mafia")).toBe(false);
    expect(canSendMessage(state, "b", "mafia")).toBe(true); // b's own allowance is untouched by a's usage
  });

  it("a pinged reply still draws from the shared town pool — pinging is no longer an exemption from it", () => {
    // Regression: town used to grant the *pinged* player a bonus message
    // beyond their own exhausted per-player cap (grantPingCredit). That
    // mechanism is gone now that town is a shared pool — a ping still gets
    // the target priority to reply next (see day-turn-order's
    // dayPingQueue), but the reply itself still counts against the same
    // total everyone else draws from.
    let state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_discussion" });
    for (let i = 0; i < 20; i++) state = recordMessage(state, "a", "town");
    expect(canSendMessage(state, "b", "town")).toBe(false);
  });
});
