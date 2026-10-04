import { describe, expect, it } from "vitest";
import { applyCommand } from "../reducer.js";
import {
  activeTeamChannels,
  advanceChannelTurn,
  currentChannelTurn,
  initializeChannelTurnQueuesForNight,
  reshuffleChannelTurnOrder,
  teamTurnStatusFor,
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

  it("leaves the queue empty (not re-opened) when the only remaining member has already acted tonight", () => {
    // Regression: found in real testing — a solo Deep Diver's channel
    // reshuffled trivially back to just them every single time (nobody
    // else to cycle to), and with AgentLoop's own idle-nudge no longer
    // gated by a blanket "already committed" flag (see agent-loop's
    // shouldPrompt fix), that meant getting re-prompted, and re-sending a
    // near-duplicate "no target, passing" message, every idle-nudge tick
    // until their whole night's message budget was burned on nothing.
    // Only applies once they've genuinely acted, though — see the next
    // test for the still-pending case, which needs the opposite behavior.
    const state = testState([seat("a", "deep_diver")], {
      phase: "night",
      channelTurnQueues: { deep_divers: ["a"] },
      nightActions: [{ actorId: "a", actionType: "deep_diver_investigate", targetId: "z", day: 1 }],
    });
    const next = advanceChannelTurn(state, "deep_divers", "a");
    expect(next.channelTurnQueues.deep_divers).toEqual([]);
    expect(next.lastChannelSpeakerId.deep_divers).toBe("a");
  });

  it("loops a lone member's turn back to them when their team action is still pending (not emptied)", () => {
    // Complement to the above, added alongside the channel-turn-gated
    // kill-proposal fix: a genuinely solo remaining Mafia/Deep Diver who
    // hasn't submitted their action yet must keep getting turns, or the
    // "forced by your 3rd turn" guarantee (see teamTurnStatusFor) could
    // never actually trigger for a team of one — there'd be no one left to
    // hand the queue back to.
    const state = testState([seat("a", "deep_diver")], {
      phase: "night",
      channelTurnQueues: { deep_divers: ["a"] },
    });
    const next = advanceChannelTurn(state, "deep_divers", "a");
    expect(next.channelTurnQueues.deep_divers).toEqual(["a"]);
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

describe("teamTurnStatusFor", () => {
  it("is undefined for a role with no team-coordinated night action", () => {
    const state = testState([seat("a", "town")], { phase: "night" });
    expect(teamTurnStatusFor(state, "a")).toBeUndefined();
  });

  it("reports isMyTurn true only for whoever's at the head of the channel queue", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a", "b"] },
    });
    expect(teamTurnStatusFor(state, "a")?.isMyTurn).toBe(true);
    expect(teamTurnStatusFor(state, "b")?.isMyTurn).toBe(false);
  });

  it("counts turnsTakenTonight from messages already posted in the team channel tonight", () => {
    const state = testState([seat("a", "mafia")], {
      phase: "night",
      dayNumber: 2,
      channelTurnQueues: { mafia: ["a"] },
      chatLog: [
        { id: "m1", channel: "mafia", authorId: "a", message: "hi", day: 2, phase: "night" },
        { id: "m2", channel: "mafia", authorId: "a", message: "still thinking", day: 2, phase: "night" },
        // Different day, and a different channel/author — neither should count.
        { id: "m3", channel: "mafia", authorId: "a", message: "old", day: 1, phase: "night" },
        { id: "m4", channel: "town", authorId: "a", message: "unrelated", day: 2, phase: "day_discussion" },
      ],
    });
    expect(teamTurnStatusFor(state, "a")?.turnsTakenTonight).toBe(2);
  });

  it("mustActNow is true only once it's their turn, they've had 2 turns already, and still haven't acted", () => {
    const chatLog = [
      { id: "m1", channel: "mafia" as const, authorId: "a", message: "1", day: 1, phase: "night" as const },
      { id: "m2", channel: "mafia" as const, authorId: "a", message: "2", day: 1, phase: "night" as const },
    ];
    const notYourTurn = testState([seat("a", "mafia"), seat("b", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["b", "a"] },
      chatLog,
    });
    expect(teamTurnStatusFor(notYourTurn, "a")?.mustActNow).toBe(false);

    const yourTurnButOnlyOneSoFar = testState([seat("a", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a"] },
      chatLog: [chatLog[0]!],
    });
    expect(teamTurnStatusFor(yourTurnButOnlyOneSoFar, "a")?.mustActNow).toBe(false);

    const yourThirdTurn = testState([seat("a", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a"] },
      chatLog,
    });
    expect(teamTurnStatusFor(yourThirdTurn, "a")?.mustActNow).toBe(true);
  });

  it("mustActNow is false once they've already submitted the team action, even with 2+ turns taken", () => {
    const state = testState([seat("a", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a"] },
      chatLog: [
        { id: "m1", channel: "mafia", authorId: "a", message: "1", day: 1, phase: "night" },
        { id: "m2", channel: "mafia", authorId: "a", message: "2", day: 1, phase: "night" },
      ],
      nightActions: [{ actorId: "a", actionType: "mafia_kill_proposal", targetId: "z", day: 1 }],
    });
    expect(teamTurnStatusFor(state, "a")?.mustActNow).toBe(false);
    expect(teamTurnStatusFor(state, "a")?.hasActedTonight).toBe(true);
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

  // Regression: kill-proposal announcements used to post via a completely
  // separate path (TEAM_CHAT_ACTIONS in reducer.ts) that never touched the
  // channel's turn queue at all — any Mafia member could submit/resubmit a
  // proposal at any moment regardless of whose turn it nominally was,
  // effectively making the mafia channel free-for-all despite send_chat
  // itself being correctly turn-gated. Found live: a fast model could
  // exhaust its own turns proposing before a slower teammate ever spoke.
  it("rejects a kill proposal submitted out of the mafia channel's turn", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia"), seat("victim", "town")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a", "b"] },
    });
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "b",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "victim",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/isn't your turn/);
  });

  it("accepts an in-turn kill proposal and advances the channel queue, same as a chat message would", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia"), seat("victim", "town")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a", "b"] },
    });
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "victim",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentChannelTurn(result.state, "mafia")).toBe("b");
  });

  it("lets a Mafia member spend their first two turns on plain chat, then forces the proposal on the third", () => {
    let state = testState([seat("a", "mafia"), seat("victim", "town")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a"] },
    });

    const turn1 = applyCommand(state, { type: "send_chat", playerId: "a", channel: "mafia", message: "thinking" });
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    state = turn1.state;

    const turn2 = applyCommand(state, { type: "send_chat", playerId: "a", channel: "mafia", message: "still thinking" });
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    state = turn2.state;

    // Third turn: chat is no longer an option, only the real proposal —
    // rejected either by the explicit mustActNow check or (as here, since
    // mafiaNight's default cap of 2 lines up exactly with "2 free turns")
    // by plain budget exhaustion. Either way, the outcome that matters is
    // that chat is genuinely blocked and the proposal is what's left.
    const chatAttempt = applyCommand(state, { type: "send_chat", playerId: "a", channel: "mafia", message: "one more sec" });
    expect(chatAttempt.ok).toBe(false);

    const proposal = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "victim",
    });
    expect(proposal.ok).toBe(true);
  });

  it("still allows revising an already-submitted proposal on a later turn (not one-and-done)", () => {
    let state = testState([seat("a", "mafia"), seat("b", "mafia"), seat("v1", "town"), seat("v2", "town")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a", "b"] },
    });

    const propose = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "v1",
    });
    expect(propose.ok).toBe(true);
    if (!propose.ok) return;
    state = propose.state; // queue: [b, a]

    const bTurn = applyCommand(state, { type: "send_chat", playerId: "b", channel: "mafia", message: "hmm" });
    expect(bTurn.ok).toBe(true);
    if (!bTurn.ok) return;
    state = bTurn.state; // queue: [a, b]

    const revise = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "v2",
    });
    expect(revise.ok).toBe(true);
    if (!revise.ok) return;
    expect(revise.state.nightActions.find((na) => na.actorId === "a")?.targetId).toBe("v2");
  });

  it("advances the channel queue when a team-coordinated role passes, avoiding a deadlock", () => {
    const state = testState([seat("a", "mafia"), seat("b", "mafia")], {
      phase: "night",
      channelTurnQueues: { mafia: ["a", "b"] },
    });
    const result = applyCommand(state, { type: "pass", playerId: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentChannelTurn(result.state, "mafia")).toBe("b");
  });
});
