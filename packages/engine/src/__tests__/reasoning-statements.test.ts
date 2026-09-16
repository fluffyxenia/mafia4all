import { describe, expect, it } from "vitest";
import { applyCommand } from "../reducer.js";
import { resolveNight } from "../resolution/night.js";
import { resolveDayVote } from "../resolution/day-vote.js";
import { resolveJesterRevenge } from "../resolution/jester-revenge.js";
import { seat, testState } from "./test-helpers.js";

describe("cast_vote auto-statements", () => {
  it("posts the voter's own reasoning as their statement, replacing the generic default", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_vote", dayVoteQueue: ["a", "b"] });
    const result = applyCommand(state, {
      type: "cast_vote",
      playerId: "a",
      target: "b",
      reasoning: "b's story keeps changing.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.state.chatLog.find((m) => m.channel === "town" && m.authorId === "a");
    expect(msg?.message).toBe("b's story keeps changing.");
  });

  it("falls back to a generic statement when no reasoning is given", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_vote", dayVoteQueue: ["a", "b"] });
    const result = applyCommand(state, { type: "cast_vote", playerId: "a", target: "abstain" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.state.chatLog.find((m) => m.channel === "town" && m.authorId === "a");
    expect(msg?.message).toBe("I'll abstain for now.");
  });
});

describe("night_action auto-statements", () => {
  it("posts a mafia proposal + reasoning into the mafia channel, visible to teammates", () => {
    const state = testState([seat("mafia1", "mafia"), seat("mafia2", "mafia"), seat("victim", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "mafia1",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "victim",
      reasoning: "They've been too quiet all game.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.state.chatLog.find((m) => m.channel === "mafia" && m.authorId === "mafia1");
    expect(msg?.message).toBe("They've been too quiet all game.");
  });

  it("does not spend the mafia channel's turn budget on the auto-posted proposal", () => {
    const state = testState([seat("mafia1", "mafia"), seat("victim", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "mafia1",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "victim",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turnBudgets.used["mafia1"]?.mafia ?? 0).toBe(0);
  });

  it("uses the default flavor line for a Vigilante hold with no reasoning given", () => {
    const state = testState([seat("vig", "vigilante"), seat("townie", "town")]);
    const result = applyCommand(state, { type: "night_action", playerId: "vig", actionType: "vigilante_hold" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.state.privateLog.find((l) => l.ownerId === "vig" && l.kind === "statement");
    expect(entry?.text).toBe("I'll hold my fire for now.");
  });

  it("records a solo role's reasoning as a private statement entry, not team chat", () => {
    const state = testState([seat("doc", "doctor"), seat("townie", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "doc",
      actionType: "doctor_protect",
      targetPlayerId: "townie",
      reasoning: "They were accused twice today.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.state.privateLog.find((l) => l.ownerId === "doc" && l.kind === "statement");
    expect(entry?.text).toBe("They were accused twice today.");
    expect(result.state.chatLog).toHaveLength(0);
  });
});

describe("night-resolution narrator announcements", () => {
  it("announces a night death in town chat the next morning", () => {
    const state = testState([seat("mafia1", "mafia"), seat("victim", "town")], {
      nightActions: [{ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "victim", day: 1 }],
    });
    const { state: next } = resolveNight(state);
    const announcements = next.chatLog.filter((m) => m.system && m.channel === "town").map((m) => m.message);
    // Two separate narrator lines now: the death itself, and (added
    // separately, in apply-deaths.ts, for every death regardless of cause)
    // the Mafia-association reveal every remaining player uses to gauge
    // threats.
    expect(announcements).toContain("victim was found dead this morning.");
    expect(announcements).toContain("victim was not Mafia.");
  });

  it("announces heartbreak with distinct flavor text", () => {
    const state = testState(
      [
        seat("mafia1", "mafia"),
        seat("loverA", "town", { loverPairId: "pair0" }),
        seat("loverB", "doctor", { loverPairId: "pair0" }),
      ],
      { nightActions: [{ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "loverA", day: 1 }] },
    );
    const { state: next } = resolveNight(state);
    const heartbreak = next.chatLog.find((m) => m.message.includes("heartbreak"));
    expect(heartbreak?.message).toBe("loverB could not bear the loss and dies of heartbreak.");
  });

  it("announces a peaceful night when nobody died", () => {
    const state = testState([seat("doc", "doctor"), seat("townie", "town")]);
    const { state: next } = resolveNight(state);
    const announcement = next.chatLog.find((m) => m.system);
    expect(announcement?.message).toBe("Nobody died last night.");
  });
});

describe("day-vote narrator announcements", () => {
  it("announces an elimination with the vote count", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia"), seat("c", "town"), seat("d", "mafia")], {
      phase: "day_vote",
      votes: [
        { voterId: "a", target: "b", day: 1 },
        { voterId: "c", target: "b", day: 1 },
      ],
    });
    const { state: next } = resolveDayVote(state);
    const announcement = next.chatLog.find((m) => m.system);
    expect(announcement?.message).toBe("b was voted out with 2 vote(s).");
  });

  it("announces a no-elimination day on a tie", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_vote",
      votes: [
        { voterId: "a", target: "b", day: 1 },
        { voterId: "b", target: "a", day: 1 },
      ],
    });
    const { state: next } = resolveDayVote(state);
    const announcement = next.chatLog.find((m) => m.system);
    expect(announcement?.message).toBe("No one was eliminated today.");
  });

  it("announces the extended-discussion outcome for request_more_messages", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_vote",
      votes: [
        { voterId: "a", target: "request_more_messages", day: 1 },
        { voterId: "b", target: "request_more_messages", day: 1 },
      ],
    });
    const { state: next } = resolveDayVote(state);
    const announcement = next.chatLog.find((m) => m.system);
    expect(announcement?.message).toBe("The town has voted to extend discussion.");
  });
});

describe("jester revenge auto-statements and narration", () => {
  it("posts the jester's reasoning as their own town-chat statement, plus a narrator outcome line", () => {
    const state = testState(
      [
        seat("jester", "jester", { alive: false, deathCause: "day_vote", deathDay: 1 }),
        seat("accuser1", "town"),
        seat("bystander", "town"),
      ],
      {
        phase: "jester_revenge_subphase",
        pendingJesterRevenge: { jesterId: "jester", eligibleTargets: ["accuser1"], day: 1 },
      },
    );
    const { state: next } = resolveJesterRevenge(state, "accuser1", "You voted first — you go first.");
    const jesterStatement = next.chatLog.find((m) => m.authorId === "jester" && !m.system);
    expect(jesterStatement?.message).toBe("You voted first — you go first.");
    // Two narrator lines now: the Mafia-association reveal (added in
    // apply-deaths.ts for every death) fires first, then this subphase's own
    // outcome line.
    const narrated = next.chatLog.filter((m) => m.system).map((m) => m.message);
    expect(narrated).toContain("accuser1 was not Mafia.");
    expect(narrated).toContain("accuser1 is eliminated in the Jester's revenge.");
  });

  it("uses the default flavor line and narrates declining revenge", () => {
    const state = testState(
      [
        seat("jester", "jester", { alive: false, deathCause: "day_vote", deathDay: 1 }),
        seat("accuser1", "town"),
        seat("bystander", "town"),
      ],
      {
        phase: "jester_revenge_subphase",
        pendingJesterRevenge: { jesterId: "jester", eligibleTargets: ["accuser1"], day: 1 },
      },
    );
    const { state: next } = resolveJesterRevenge(state, undefined);
    const narrated = next.chatLog.find((m) => m.system);
    expect(narrated?.message).toBe("jester chooses not to take revenge.");
  });
});
