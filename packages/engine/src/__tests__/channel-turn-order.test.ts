import { describe, expect, it } from "vitest";
import { applyCommand } from "../reducer.js";
import {
  activeTeamChannels,
  advanceChannelTurn,
  currentChannelTurn,
  initializeChannelTurnQueuesForNight,
  reshuffleChannelTurnOrder,
} from "../channel-turn-order.js";
import { seat, testState } from "./test-helpers.js";

describe("activeTeamChannels", () => {
  it("includes mafia and deep_divers only when someone actually holds that role", () => {
    const state = testState([seat("a", "mafia"), seat("b", "town")]);
    expect(activeTeamChannels(state)).toEqual(["mafia"]);
  });

  it("includes one channel per lover pair, alongside mafia/deep_divers", () => {
    const state = testState([
      seat("a", "mafia"),
      seat("b", "deep_diver"),
      seat("c", "town", { loverPairId: "pair0" }),
      seat("d", "town", { loverPairId: "pair0" }),
    ]);
    expect(new Set(activeTeamChannels(state))).toEqual(new Set(["mafia", "deep_divers", "lovers:pair0"]));
  });
});

describe("reshuffleChannelTurnOrder / currentChannelTurn", () => {
  it("fills the queue with exactly the alive channel members who still have budget", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia", { alive: false }), seat("c", "mafia")], {
      phase: "night",
    });
    const next = reshuffleChannelTurnOrder(state, "mafia");
    expect(new Set(next.channelTurnQueues.mafia)).toEqual(new Set(["a", "c"]));
  });

  it("never lets the same player go first twice in a row when avoidFirst is given, with only two eligible", () => {
    for (let seed = 0; seed < 50; seed++) {
      const state = testState([seat("a", "mafia"), seat("b", "mafia")], { phase: "night", rngState: seed });
      const next = reshuffleChannelTurnOrder(state, "mafia", "b");
      expect(next.channelTurnQueues.mafia?.[0]).toBe("a");
    }
  });
});

describe("advanceChannelTurn", () => {
  it("removes the front player from the channel's queue without reshuffling mid-cycle", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia"), seat("c", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a", "b", "c"] },
    });
    const next = advanceChannelTurn(state, "mafia", "a");
    expect(next.channelTurnQueues.mafia).toEqual(["b", "c"]);
    expect(next.lastChannelSpeakerId.mafia).toBe("a");
  });

  it("reshuffles a fresh cycle once the channel's queue is exhausted, avoiding an immediate repeat", () => {
    for (let seed = 0; seed < 50; seed++) {
      const state = testState([seat("a", "mafia"), seat("b", "mafia")], {
        phase: "night",
        channelTurnQueues: { mafia: ["b"] },
        rngState: seed,
      });
      const next = advanceChannelTurn(state, "mafia", "b");
      expect(next.channelTurnQueues.mafia?.[0]).toBe("a");
    }
  });

  it("leaves the queue empty (not re-opened) when the only remaining member is the one who just spoke", () => {
    // Regression: found in real testing — a solo Deep Diver's channel
    // reshuffled trivially back to just them every single time (nobody
    // else to cycle to), and with AgentLoop's own idle-nudge no longer
    // gated by a blanket "already committed" flag (see agent-loop's
    // shouldPrompt fix), that meant getting re-prompted, and re-sending a
    // near-duplicate "no target, passing" message, every idle-nudge tick
    // until their whole night's message budget was burned on nothing.
    const state = testState([seat("a", "deep_diver")], {
      phase: "night",
      channelTurnQueues: { deep_divers: ["a"] },
    });
    const next = advanceChannelTurn(state, "deep_divers", "a");
    expect(next.channelTurnQueues.deep_divers).toEqual([]);
    expect(next.lastChannelSpeakerId.deep_divers).toBe("a");
  });

  it("does not touch a different channel's queue", () => {
    const state = testState([seat("a", "mafia"), seat("b", "deep_diver")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a"], deep_divers: ["b"] },
    });
    const next = advanceChannelTurn(state, "mafia", "a");
    expect(next.channelTurnQueues.deep_divers).toEqual(["b"]);
  });
});

describe("initializeChannelTurnQueuesForNight", () => {
  it("seeds a fresh queue for every structurally-active team channel", () => {
    const state = testState([
      seat("a", "mafia"),
      seat("b", "mafia"),
      seat("c", "deep_diver"),
      seat("d", "town", { loverPairId: "pair0" }),
      seat("e", "town", { loverPairId: "pair0" }),
    ]);
    const next = initializeChannelTurnQueuesForNight(state);
    expect(new Set(next.channelTurnQueues.mafia)).toEqual(new Set(["a", "b"]));
    expect(next.channelTurnQueues.deep_divers).toEqual(["c"]);
    expect(next.channelTurnQueues["lovers:pair0"]).toEqual(expect.arrayContaining(["d", "e"]));
  });

  it("skips a channel with nobody currently eligible instead of seeding an empty queue that blocks nothing", () => {
    const state = testState([seat("a", "town")]);
    const next = initializeChannelTurnQueuesForNight(state);
    expect(next.channelTurnQueues.mafia).toBeUndefined();
  });

  it("avoids repeating the previous night's last speaker in that channel", () => {
    for (let seed = 0; seed < 50; seed++) {
      const state = testState([seat("a", "mafia"), seat("b", "mafia")], {
        rngState: seed,
        lastChannelSpeakerId: { mafia: "b" },
      });
      const next = initializeChannelTurnQueuesForNight(state);
      expect(next.channelTurnQueues.mafia?.[0]).toBe("a");
    }
  });
});

describe("end-to-end: mafia chat turn order enforced through applyCommand + tryAdvancePhase", () => {
  it("is seeded fresh the moment night begins, and enforced turn-by-turn", () => {
    let state = testState([seat("a", "mafia"), seat("b", "mafia"), seat("c", "town")], { phase: "night" });
    state = initializeChannelTurnQueuesForNight(state);
    const first = currentChannelTurn(state, "mafia")!;
    const second = first === "a" ? "b" : "a";

    const outOfTurn = applyCommand(state, { type: "send_chat", playerId: second, channel: "mafia", message: "hi" });
    expect(outOfTurn.ok).toBe(false);

    const inTurn = applyCommand(state, { type: "send_chat", playerId: first, channel: "mafia", message: "hi" });
    expect(inTurn.ok).toBe(true);
    if (!inTurn.ok) return;
    expect(currentChannelTurn(inTurn.state, "mafia")).toBe(second);
  });
});
