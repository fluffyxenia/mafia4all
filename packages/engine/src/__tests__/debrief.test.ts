import { describe, expect, it } from "vitest";
import { applyCommand } from "../reducer.js";
import { tryAdvancePhase } from "../advance.js";
import { currentDebriefTurn, advanceDebriefQueue } from "../debrief.js";
import { buildPlayerView } from "../view.js";
import { seat, testState } from "./test-helpers.js";

describe("currentDebriefTurn / advanceDebriefQueue", () => {
  it("returns the front of the queue and pops exactly that player on advance", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia")], {
      phase: "debrief",
      debriefQueue: ["a", "b"],
    });
    expect(currentDebriefTurn(state)).toBe("a");
    const next = advanceDebriefQueue(state, "a");
    expect(next.debriefQueue).toEqual(["b"]);
    expect(currentDebriefTurn(next)).toBe("b");
  });

  it("is a no-op if the given player isn't actually at the front", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia")], {
      phase: "debrief",
      debriefQueue: ["a", "b"],
    });
    const next = advanceDebriefQueue(state, "b");
    expect(next.debriefQueue).toEqual(["a", "b"]);
  });
});

describe("send_chat during debrief", () => {
  it("lets a dead player speak, out of turn order otherwise enforced everywhere else", () => {
    const state = testState([seat("a", "town", { alive: false }), seat("b", "mafia")], {
      phase: "debrief",
      debriefQueue: ["a", "b"],
    });
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "gg" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.debriefQueue).toEqual(["b"]);
    expect(result.state.chatLog).toHaveLength(1);
  });

  it("rejects a message from anyone but whoever is currently at the front of the queue", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia")], {
      phase: "debrief",
      debriefQueue: ["a", "b"],
    });
    const result = applyCommand(state, { type: "send_chat", playerId: "b", channel: "town", message: "gg" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not your turn/);
  });

  it("rejects a channel other than town", () => {
    const state = testState([seat("a", "mafia")], { phase: "debrief", debriefQueue: ["a"] });
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "mafia", message: "gg" });
    expect(result.ok).toBe(false);
  });

  it("does not allow a second message from someone who already spoke — exactly one each", () => {
    const state = testState([seat("a", "town")], { phase: "debrief", debriefQueue: ["a"] });
    const first = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "gg" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyCommand(first.state, { type: "send_chat", playerId: "a", channel: "town", message: "again?" });
    expect(second.ok).toBe(false);
  });
});

describe("debrief -> post_game phase transition", () => {
  it("stays in debrief until every seated player has spoken once", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia", { alive: false })], {
      phase: "debrief",
      debriefQueue: ["a", "b"],
    });
    const afterA = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "gg" });
    expect(afterA.ok).toBe(true);
    if (!afterA.ok) return;
    expect(tryAdvancePhase(afterA.state)).toBeNull();

    const afterB = applyCommand(afterA.state, { type: "send_chat", playerId: "b", channel: "town", message: "well played" });
    expect(afterB.ok).toBe(true);
    if (!afterB.ok) return;
    const advanced = tryAdvancePhase(afterB.state);
    expect(advanced).not.toBeNull();
    expect(advanced!.state.phase).toBe("post_game");
  });
});

describe("buildPlayerView during debrief", () => {
  it("reveals every role and channel, and reports whose turn it is, even for a dead player", () => {
    const state = testState([seat("a", "town", { alive: false }), seat("b", "mafia")], {
      phase: "debrief",
      debriefQueue: ["a", "b"],
      winner: { result: "mafia", winningPlayerIds: ["b"] },
    });
    const view = buildPlayerView(state, "a");
    expect(view.self.alive).toBe(false);
    expect(view.roster.find((r) => r.id === "b")?.revealedRole).toBe("mafia");
    expect(view.visibleChannels).toContain("mafia");
    expect(view.debriefTurnPlayerId).toBe("a");
    expect(view.winner?.result).toBe("mafia");
  });
});
