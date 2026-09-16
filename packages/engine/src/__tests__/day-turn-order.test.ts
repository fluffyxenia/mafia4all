import { describe, expect, it } from "vitest";
import { applyCommand } from "../reducer.js";
import { reshuffleDayTurnOrder, currentDayTurn, advanceDayTurn, enqueuePing } from "../day-turn-order.js";
import { tryAdvancePhase } from "../advance.js";
import { seat, testState } from "./test-helpers.js";

describe("reshuffleDayTurnOrder", () => {
  it("fills the queue with exactly the alive players who still have town budget", () => {
    const state = testState(
      [seat("a", "town"), seat("b", "town", { alive: false }), seat("c", "town")],
      { phase: "day_discussion" },
    );
    const next = reshuffleDayTurnOrder(state);
    expect(new Set(next.dayTurnQueue)).toEqual(new Set(["a", "c"]));
    expect(next.dayPingQueue).toHaveLength(0);
  });

  it("excludes every alive player once the shared town pool is exhausted", () => {
    // Regression: town's day_discussion cap is a single pool shared by the
    // whole table now, not a per-player allowance — one player having
    // personally sent a lot of messages no longer excludes just them;
    // only the pool itself running out excludes everyone at once.
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_discussion",
      turnBudgets: { used: { a: { town: 20 } }, pingCredits: {} },
    });
    const next = reshuffleDayTurnOrder(state);
    expect(next.dayTurnQueue).toEqual([]);
  });

  it("keeps every alive player eligible even after one of them has sent many messages, as long as the shared pool still has room", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_discussion",
      turnBudgets: { used: { a: { town: 15 } }, pingCredits: {} },
    });
    const next = reshuffleDayTurnOrder(state);
    expect(new Set(next.dayTurnQueue)).toEqual(new Set(["a", "b"]));
  });

  it("advances rngState so consecutive reshuffles aren't identical", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      phase: "day_discussion",
      rngState: 12345,
    });
    const first = reshuffleDayTurnOrder(state);
    const second = reshuffleDayTurnOrder(first);
    expect(second.rngState).not.toBe(first.rngState);
  });
});

describe("currentDayTurn", () => {
  it("prioritizes the ping queue over the normal turn queue", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      dayTurnQueue: ["a"],
      dayPingQueue: ["b"],
    });
    expect(currentDayTurn(state)).toBe("b");
  });

  it("falls back to the normal turn queue when nobody's been pinged", () => {
    const state = testState([seat("a", "town")], { dayTurnQueue: ["a"], dayPingQueue: [] });
    expect(currentDayTurn(state)).toBe("a");
  });
});

describe("advanceDayTurn", () => {
  it("removes the front player from the normal queue without reshuffling mid-cycle", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["a", "b", "c"],
    });
    const next = advanceDayTurn(state, "a");
    expect(next.dayTurnQueue).toEqual(["b", "c"]);
  });

  it("reshuffles a fresh cycle once the queue is exhausted", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["b"],
    });
    const next = advanceDayTurn(state, "b");
    expect(new Set(next.dayTurnQueue)).toEqual(new Set(["a", "b"]));
  });

  it("never lets the same player go twice in a row across a cycle boundary, with only two eligible", () => {
    // Regression: a plain reshuffle has a real chance of putting whoever
    // just spoke right back at the front, which reads as "not random, it's
    // just bouncing between two people" — confirmed live with two human
    // players once everyone else was dead/passed. With exactly two
    // eligible players this must force strict alternation every time.
    for (let seed = 0; seed < 50; seed++) {
      const state = testState([seat("a", "town"), seat("b", "town")], {
        phase: "day_discussion",
        dayTurnQueue: ["b"],
        rngState: seed,
      });
      const next = advanceDayTurn(state, "b");
      expect(next.dayTurnQueue[0]).toBe("a");
    }
  });

  it("does not force alternation when a third player is eligible (avoidFirst only applies if it would collide)", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["c"],
      rngState: 99,
    });
    const next = advanceDayTurn(state, "c");
    expect(new Set(next.dayTurnQueue)).toEqual(new Set(["a", "b", "c"]));
    // "c" may legitimately land anywhere except forced-first only when
    // there's no alternative — with 3 eligible players it's just excluded
    // from position 0 specifically when the raw shuffle happened to put it
    // there; either way this must not throw or drop a player.
    expect(next.dayTurnQueue).toHaveLength(3);
  });

  it("removes a satisfied ping from the ping queue without touching the normal queue", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      dayTurnQueue: ["a"],
      dayPingQueue: ["b"],
    });
    const next = advanceDayTurn(state, "b");
    expect(next.dayPingQueue).toHaveLength(0);
    expect(next.dayTurnQueue).toEqual(["a"]);
  });

  it("clears a player from both queues at once when they're up next in both, instead of leaving them owed a second immediate turn", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      dayTurnQueue: ["a", "b", "c"],
      dayPingQueue: ["a"],
    });
    const next = advanceDayTurn(state, "a");
    expect(next.dayPingQueue).toHaveLength(0);
    expect(next.dayTurnQueue).toEqual(["b", "c"]);
    expect(currentDayTurn(next)).toBe("b");
  });

  it("records the speaker as lastTownSpeakerId", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["a", "b"],
    });
    const next = advanceDayTurn(state, "a");
    expect(next.lastTownSpeakerId).toBe("a");
  });
});

describe("night -> day_discussion phase transition", () => {
  it("never lets the previous day's last speaker open the new day's cycle too", () => {
    // Regression: this reshuffle (in advance.ts) used to omit avoidFirst
    // entirely, so whoever spoke last before night fell could open the
    // next day's discussion too, with nothing but a private night phase in
    // between. Town's per-player exclusion is gone now (day_discussion is a
    // shared pool — see turn-budget.ts), so this no longer reduces to a
    // clean two-candidate coin flip; with three eligible players (a, b, m)
    // the only thing avoidFirst guarantees is that "b" specifically isn't
    // first, not which of the other two is.
    for (let seed = 0; seed < 50; seed++) {
      // A mafia seat keeps the game from resolving as a Town win the
      // instant night ends (no hostile survivors left) — held fire (no
      // recorded kill) so nobody dies.
      const state = testState([seat("a", "town"), seat("b", "town"), seat("m", "mafia")], {
        phase: "night",
        dayNumber: 1,
        rngState: seed,
        lastTownSpeakerId: "b",
        turnBudgets: { used: { m: { mafia: 6 } }, pingCredits: {} },
      });
      const result = tryAdvancePhase(state);
      expect(result).not.toBeNull();
      expect(result!.state.phase).toBe("day_discussion");
      expect(result!.state.dayTurnQueue[0]).not.toBe("b");
    }
  });
});

describe("enqueuePing", () => {
  it("appends the target to the ping queue", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { dayPingQueue: [] });
    const next = enqueuePing(state, "b");
    expect(next.dayPingQueue).toEqual(["b"]);
  });

  it("does not duplicate an already-queued ping target", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { dayPingQueue: ["b"] });
    const next = enqueuePing(state, "b");
    expect(next.dayPingQueue).toEqual(["b"]);
  });
});

describe("turn order enforced end-to-end through applyCommand", () => {
  it("rejects town chat from someone whose turn it isn't", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["b"],
    });
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "hi" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not your turn/);
  });

  it("gates private team channels by turn order too, same as town", () => {
    // Regression: mafia/deep_divers/lovers used to be free-for-all,
    // budget-limited only — found in real testing to be a real fairness
    // problem, not a non-issue: a fast model could burn its whole night-chat
    // budget before a slower teammate got a single message in.
    const state = testState([seat("a", "mafia"), seat("b", "mafia"), seat("c", "town")], {
      phase: "night",
      channelTurnQueues: { mafia: ["b", "a"] },
    });
    const outOfTurn = applyCommand(state, { type: "send_chat", playerId: "a", channel: "mafia", message: "hi" });
    expect(outOfTurn.ok).toBe(false);
    if (outOfTurn.ok) return;
    expect(outOfTurn.error).toMatch(/not your turn/);

    const inTurn = applyCommand(state, { type: "send_chat", playerId: "b", channel: "mafia", message: "hi" });
    expect(inTurn.ok).toBe(true);
    if (!inTurn.ok) return;
    expect(inTurn.state.channelTurnQueues.mafia).toEqual(["a"]);
  });

  it("advances to the next player's turn after a successful message", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["a", "b"],
    });
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "hi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.dayTurnQueue).toEqual(["b"]);
  });

  it("lets a pinged player reply immediately, then resumes the normal order where it left off", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["a", "b", "c"],
    });
    // a's turn: pings c instead of just talking.
    const pinged = applyCommand(state, {
      type: "ping_player",
      playerId: "a",
      targetPlayerId: "c",
      message: "what do you think?",
    });
    expect(pinged.ok).toBe(true);
    if (!pinged.ok) return;
    expect(pinged.state.dayTurnQueue).toEqual(["b", "c"]);
    expect(pinged.state.dayPingQueue).toEqual(["c"]);

    // Even though the normal queue now says "b", c was pinged and must go first.
    const bTriesEarly = applyCommand(pinged.state, {
      type: "send_chat",
      playerId: "b",
      channel: "town",
      message: "hi",
    });
    expect(bTriesEarly.ok).toBe(false);

    const cReplies = applyCommand(pinged.state, {
      type: "send_chat",
      playerId: "c",
      channel: "town",
      message: "sure, here's my take",
    });
    expect(cReplies.ok).toBe(true);
    if (!cReplies.ok) return;
    // Ping satisfied and cleared; normal order resumes exactly where it was (b, then c again).
    expect(cReplies.state.dayPingQueue).toHaveLength(0);
    expect(cReplies.state.dayTurnQueue).toEqual(["b", "c"]);
  });

  it("rejects pass during day_discussion — there is no early exit from the turn cycle", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      phase: "day_discussion",
      dayTurnQueue: ["a", "b", "c"],
    });
    const result = applyCommand(state, { type: "pass", playerId: "a" });
    expect(result.ok).toBe(false);
  });
});
