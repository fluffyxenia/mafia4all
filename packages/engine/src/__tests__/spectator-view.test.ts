import { describe, expect, it } from "vitest";
import { buildSpectatorView, SPECTATOR_PLAYER_ID } from "../view.js";
import { seat, testState } from "./test-helpers.js";

describe("buildSpectatorView", () => {
  it("reveals every player's real role regardless of alignment or alive status", () => {
    const state = testState([
      seat("mafia1", "mafia"),
      seat("doc", "doctor", { alive: false, deathCause: "mafia_kill", deathDay: 1 }),
      seat("townie", "town"),
    ]);
    const view = buildSpectatorView(state);
    expect(view.roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mafia1", revealedRole: "mafia" }),
        expect.objectContaining({ id: "doc", revealedRole: "doctor", alive: false }),
        expect.objectContaining({ id: "townie", revealedRole: "town" }),
      ]),
    );
  });

  it("sees every channel and the entire chat log, including a private mafia message a plain player never would", () => {
    const state = testState([seat("mafia1", "mafia"), seat("mafia2", "mafia"), seat("townie", "town")], {
      chatLog: [
        { id: "m1", channel: "mafia", authorId: "mafia1", message: "let's get townie", day: 1, phase: "night" },
      ],
    });
    const view = buildSpectatorView(state);
    expect(view.visibleChannels).toContain("mafia");
    expect(view.chatLog).toHaveLength(1);
    expect(view.chatLog[0]?.message).toBe("let's get townie");
  });

  it("sees every player's private log entries, not just one owner's", () => {
    const state = testState([seat("doc", "doctor"), seat("sheriff", "sheriff"), seat("townie", "town")], {
      privateLog: [
        { ownerId: "doc", day: 1, kind: "statement", text: "protecting townie" },
        { ownerId: "sheriff", day: 1, kind: "investigation", text: "townie is not mafia" },
      ],
    });
    const view = buildSpectatorView(state);
    expect(view.privateLog).toHaveLength(2);
  });

  it("uses a sentinel playerId/self that never matches a real seat", () => {
    const state = testState([seat("p1", "town")]);
    const view = buildSpectatorView(state);
    expect(view.playerId).toBe(SPECTATOR_PLAYER_ID);
    expect(view.roster.some((r) => r.id === view.playerId)).toBe(false);
    expect(view.self.role).toBe("spectator");
    expect(view.turnBudgets).toEqual([]);
  });
});
