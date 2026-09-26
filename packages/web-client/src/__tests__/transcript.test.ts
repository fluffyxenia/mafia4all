import { describe, expect, it } from "vitest";
import { buildReplayView, rosterAsOf, shortId, validateReplayable } from "../transcript.js";
import type { RawTranscript } from "../transcript.js";

function rawTranscript(overrides: Partial<RawTranscript> = {}): RawTranscript {
  return {
    phase: "post_game",
    dayNumber: 3,
    players: [
      { id: "p1", displayName: "Boonie V3.3", alive: false, role: "mafia", color: "#fff", icon: "🦊", deathDay: 2 },
      { id: "p2", displayName: "fluffyxenia (admin)", alive: true, role: "tanner" },
      { id: "p3", displayName: "DeepSeek V4.1", alive: false, role: "doctor", deathDay: 1, deathCause: "day_vote" },
    ],
    chatLog: [
      { id: "msg1", channel: "mafia", authorId: "p1", message: "locking in p2", day: 1, phase: "night" },
      { id: "msg2", channel: "town", authorId: "narrator", message: "p2 died", day: 1, phase: "night", system: true },
    ],
    privateLog: [{ ownerId: "p2", day: 1, text: "You protected p2 tonight." }],
    setupConfig: { roleDistribution: { mafia: 1, tanner: 1 } },
    winner: { result: "town", winningPlayerIds: ["p2"] },
    ...overrides,
  };
}

describe("validateReplayable", () => {
  it("accepts a post_game transcript with players and chatLog arrays", () => {
    expect(validateReplayable(rawTranscript())).toBe(true);
  });

  it("rejects a transcript that isn't post_game (roles still hidden, game still live)", () => {
    // Regression: replaying an in-progress game would reveal every role and
    // private-channel message to a viewer — including a player who's still
    // mid-game in that same match. Only a finished game's transcript is safe.
    expect(validateReplayable(rawTranscript({ phase: "night" }))).toBe(false);
    expect(validateReplayable(rawTranscript({ phase: "day_discussion" }))).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(validateReplayable(null)).toBe(false);
    expect(validateReplayable({})).toBe(false);
    expect(validateReplayable({ phase: "post_game" })).toBe(false);
    expect(validateReplayable("not even an object")).toBe(false);
  });
});

describe("rosterAsOf", () => {
  const raw = rawTranscript(); // p1 died day 2, p2 survived

  it("shows a player still alive during the night their death resolves (not yet announced)", () => {
    // Regression: found live — replay initially showed every eventually-dead
    // player as dead from the very first frame, because it used the
    // transcript's final roster state instead of tracking progress.
    const roster = rosterAsOf(raw, 2, "night");
    expect(roster.find((p) => p.id === "p1")?.alive).toBe(true);
  });

  it("shows a player dead once day_discussion for their death's day is revealed", () => {
    const roster = rosterAsOf(raw, 2, "day_discussion");
    expect(roster.find((p) => p.id === "p1")?.alive).toBe(false);
  });

  it("shows a player dead on any later day regardless of phase", () => {
    const roster = rosterAsOf(raw, 3, "night");
    expect(roster.find((p) => p.id === "p1")?.alive).toBe(false);
  });

  it("shows a player alive on any earlier day regardless of phase", () => {
    const roster = rosterAsOf(raw, 1, "day_vote");
    expect(roster.find((p) => p.id === "p1")?.alive).toBe(true);
  });

  it("never marks a survivor (no deathDay) dead", () => {
    const roster = rosterAsOf(raw, 99, "post_game");
    expect(roster.find((p) => p.id === "p2")?.alive).toBe(true);
  });

  describe("a day_vote death (found live: DeepSeek V4.1, day 1)", () => {
    // Regression: the original day-only heuristic treated all of a day's
    // non-night phases as one blob, so a day-voted player showed dead the
    // instant day_discussion started — hours before the actual vote
    // concluded, despite them visibly participating in that discussion.
    it("stays alive through day_discussion on their own elimination day", () => {
      expect(rosterAsOf(raw, 1, "day_discussion").find((p) => p.id === "p3")?.alive).toBe(true);
    });

    it("stays alive through day_vote itself (the vote hasn't concluded from the viewer's perspective yet)", () => {
      expect(rosterAsOf(raw, 1, "day_vote").find((p) => p.id === "p3")?.alive).toBe(true);
    });

    it("is dead once the replay moves past day_vote (debrief) the same day", () => {
      expect(rosterAsOf(raw, 1, "debrief").find((p) => p.id === "p3")?.alive).toBe(false);
    });

    it("is dead on any later day", () => {
      expect(rosterAsOf(raw, 2, "night").find((p) => p.id === "p3")?.alive).toBe(false);
    });
  });
});

describe("buildReplayView", () => {
  it("reveals every player's role, since the game is confirmed over", () => {
    const view = buildReplayView(rawTranscript());
    expect(view.roster.find((p) => p.id === "p1")?.revealedRole).toBe("mafia");
    expect(view.roster.find((p) => p.id === "p2")?.revealedRole).toBe("tanner");
  });

  it("passes chatLog and privateLog through unchanged, across every channel", () => {
    const raw = rawTranscript();
    const view = buildReplayView(raw);
    expect(view.chatLog).toEqual(raw.chatLog);
    expect(view.privateLog).toEqual(raw.privateLog);
    expect(view.visibleChannels).toContain("mafia");
    expect(view.visibleChannels).toContain("town");
  });

  it("carries the winner through when present", () => {
    expect(buildReplayView(rawTranscript()).winner).toEqual({ result: "town", winningPlayerIds: ["p2"] });
  });
});

describe("shortId", () => {
  it("truncates to 8 characters for compact display", () => {
    expect(shortId("3435b210-9419-40bb-a592-cef7cec54fbf")).toBe("3435b210");
  });

  it("leaves a short id untouched", () => {
    expect(shortId("abc")).toBe("abc");
  });
});
