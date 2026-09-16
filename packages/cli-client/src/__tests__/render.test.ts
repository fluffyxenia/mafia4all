import { describe, expect, it } from "vitest";
import { defaultChannelFor, formatNewActivity, formatSummary } from "../render.js";
import type { CliPlayerView } from "../view-types.js";

function baseView(overrides: Partial<CliPlayerView> = {}): CliPlayerView {
  return {
    playerId: "p1",
    phase: "day_discussion",
    dayNumber: 1,
    self: { role: "town", alignment: "town", alive: true },
    roster: [{ id: "p1", displayName: "Alice", alive: true }],
    visibleChannels: ["town"],
    chatLog: [],
    privateLog: [],
    pingCredits: 0,
    turnBudgets: [{ channel: "town", used: 0, cap: 5, canSend: true }],
    ...overrides,
  };
}

describe("formatSummary", () => {
  it("includes phase, day, role, and roster", () => {
    const text = formatSummary(baseView());
    expect(text).toContain("Day 1");
    expect(text).toContain("day_discussion");
    expect(text).toContain("town");
    expect(text).toContain("Alice");
  });

  it("shows remaining JoAT charges when present", () => {
    const text = formatSummary(
      baseView({ self: { role: "jack_of_all_trades", alignment: "town", alive: true, joatCharges: { investigate: true, protect: false, eliminate: true } } }),
    );
    expect(text).toContain("investigate");
    expect(text).toContain("eliminate");
    expect(text).not.toContain("protect,");
  });

  it("announces the winner once the game is over", () => {
    const text = formatSummary(baseView({ winner: { result: "town", winningPlayerIds: ["p1"] } }));
    expect(text).toContain("GAME OVER");
    expect(text).toContain("town wins");
  });
});

describe("formatNewActivity", () => {
  it("renders a narrator/system message without author attribution", () => {
    const next = baseView({
      chatLog: [
        {
          id: "m1",
          channel: "town",
          authorId: "narrator",
          message: "p2 was found dead this morning.",
          day: 1,
          phase: "day_discussion",
          system: true,
        },
      ],
    });
    expect(formatNewActivity(undefined, next)).toEqual(["*** p2 was found dead this morning. ***"]);
  });

  it("only prints chat messages not already seen", () => {
    const prev = baseView({
      chatLog: [{ id: "m1", channel: "town", authorId: "p2", message: "hi", day: 1, phase: "day_discussion" }],
    });
    const next = baseView({
      chatLog: [
        ...prev.chatLog,
        { id: "m2", channel: "town", authorId: "p3", message: "hello", day: 1, phase: "day_discussion" },
      ],
    });
    const lines = formatNewActivity(prev, next);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("hello");
  });

  it("prints every message on the first fetch (no previous view)", () => {
    const next = baseView({
      chatLog: [{ id: "m1", channel: "town", authorId: "p2", message: "hi", day: 1, phase: "day_discussion" }],
    });
    expect(formatNewActivity(undefined, next)).toHaveLength(1);
  });

  it("prints new private log entries appended since the last fetch", () => {
    const prev = baseView({ privateLog: [{ ownerId: "p1", day: 1, text: "you investigated p2: mafia" }] });
    const next = baseView({
      privateLog: [...prev.privateLog, { ownerId: "p1", day: 2, text: "you investigated p3: not-mafia" }],
    });
    const lines = formatNewActivity(prev, next);
    expect(lines).toEqual(["(private) you investigated p3: not-mafia"]);
  });

  it("labels another player's log entry once post-game reveals it (not framed as \"yours\")", () => {
    const prev = baseView({ privateLog: [] });
    const next = baseView({
      phase: "post_game",
      privateLog: [{ ownerId: "doctor1", day: 1, text: "you protected p1 tonight." }],
    });
    const lines = formatNewActivity(prev, next);
    expect(lines).toEqual(["(doctor1's log) you protected p1 tonight."]);
  });
});

describe("defaultChannelFor", () => {
  it("is town during day discussion", () => {
    expect(defaultChannelFor(baseView({ phase: "day_discussion" }))).toBe("town");
  });

  it("is the player's non-town channel at night", () => {
    expect(defaultChannelFor(baseView({ phase: "night", visibleChannels: ["town", "mafia"] }))).toBe("mafia");
  });

  it("is undefined for a solo role with no chat channel at night", () => {
    expect(defaultChannelFor(baseView({ phase: "night", visibleChannels: ["town"] }))).toBeUndefined();
  });

  it("is undefined during voting", () => {
    expect(defaultChannelFor(baseView({ phase: "day_vote" }))).toBeUndefined();
  });
});
