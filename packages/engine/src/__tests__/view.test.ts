import { describe, expect, it } from "vitest";
import type { ChatMessage, PrivateLogEntry } from "@mafia/shared";
import { buildPlayerView } from "../view.js";
import { seat, testState } from "./test-helpers.js";

function chat(channel: ChatMessage["channel"], authorId: string, message = "hi"): ChatMessage {
  return { id: `${channel}-${authorId}`, channel, authorId, message, day: 1, phase: "night" };
}

describe("buildPlayerView", () => {
  it("a Mafia player sees mafia chat but not the Sheriff's private log", () => {
    const state = testState(
      [seat("mafia1", "mafia"), seat("sheriff", "sheriff")],
      {
        chatLog: [chat("mafia", "mafia1", "let's kill sheriff")],
        privateLog: [
          { ownerId: "sheriff", day: 1, text: "investigated mafia1: mafia" } satisfies PrivateLogEntry,
        ],
      },
    );
    const view = buildPlayerView(state, "mafia1");
    expect(view.chatLog.some((m) => m.channel === "mafia")).toBe(true);
    expect(view.privateLog).toHaveLength(0);
  });

  it("a Town player cannot see the mafia channel at all", () => {
    const state = testState([seat("mafia1", "mafia"), seat("townie", "town")], {
      chatLog: [chat("mafia", "mafia1", "secret plan")],
    });
    const view = buildPlayerView(state, "townie");
    expect(view.visibleChannels).not.toContain("mafia");
    expect(view.chatLog).toHaveLength(0);
  });

  it("lovers channel is isolated to the pair", () => {
    const state = testState(
      [
        seat("loverA", "town", { loverPairId: "pair0" }),
        seat("loverB", "doctor", { loverPairId: "pair0" }),
        seat("outsider", "town"),
      ],
      { chatLog: [chat("lovers:pair0", "loverA", "goodnight")] },
    );
    expect(buildPlayerView(state, "loverB").chatLog).toHaveLength(1);
    expect(buildPlayerView(state, "outsider").chatLog).toHaveLength(0);
  });

  it("a Mafia player's roster reveals teammates but not other roles", () => {
    const state = testState([seat("mafia1", "mafia"), seat("mafia2", "mafia"), seat("townie", "town")]);
    const view = buildPlayerView(state, "mafia1");
    const teammate = view.roster.find((r) => r.id === "mafia2")!;
    const outsider = view.roster.find((r) => r.id === "townie")!;
    expect(teammate.revealedRole).toBe("mafia");
    expect(outsider.revealedRole).toBeUndefined();
  });

  it("clamps a voluntary pass's internal sentinel so displayed turn usage never exceeds the cap", () => {
    const state = testState([seat("a", "town")], {
      phase: "day_discussion",
      turnBudgets: { used: { a: { town: 1_000_000 } }, pingCredits: {} },
    });
    const view = buildPlayerView(state, "a");
    const townBudget = view.turnBudgets.find((b) => b.channel === "town")!;
    expect(townBudget.used).toBe(townBudget.cap);
    expect(townBudget.canSend).toBe(false);
  });

  it("post-game reveals every channel and every role to everyone", () => {
    const state = testState(
      [seat("mafia1", "mafia"), seat("townie", "town")],
      {
        phase: "post_game",
        chatLog: [chat("mafia", "mafia1", "secret plan")],
        winner: { result: "town", winningPlayerIds: ["townie"] },
      },
    );
    const view = buildPlayerView(state, "townie");
    expect(view.chatLog.some((m) => m.channel === "mafia")).toBe(true);
    expect(view.roster.find((r) => r.id === "mafia1")!.revealedRole).toBe("mafia");
  });
});
