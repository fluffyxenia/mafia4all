import { describe, expect, it } from "vitest";
import { renderHud } from "../hud.js";
import type { PlayerView } from "../view-types.js";

function baseView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: "p1",
    phase: "day_vote",
    dayNumber: 1,
    self: { role: "town", alignment: "town", alive: true },
    roster: [
      { id: "p1", displayName: "P1", alive: true },
      { id: "p2", displayName: "P2", alive: true },
    ],
    visibleChannels: ["town"],
    chatLog: [],
    privateLog: [],
    pingCredits: 0,
    turnBudgets: [{ channel: "town", used: 20, cap: 20, canSend: false }],
    ...overrides,
  };
}

function fakeEl(): HTMLElement {
  return { innerHTML: "" } as unknown as HTMLElement;
}

describe("renderHud", () => {
  it("shows whose turn it is to vote during day_vote, not just the frozen day_discussion budget", () => {
    // Regression: found live — day_vote has no shared-pool budget of its
    // own (voting is sequential turn order, not a message budget), so the
    // town budget line just stays frozen at whatever day_discussion left it
    // at (e.g. "town 20/20") for the entire vote, with nothing else in the
    // HUD showing real voting progress — reading exactly like the UI was
    // stuck, when the vote was actually advancing normally.
    const el = fakeEl();
    renderHud(el, baseView({ dayVoteTurnPlayerId: "p2" }));
    expect(el.innerHTML).toContain("Waiting on P2 to vote…");
  });

  it("tells the current voter it's their own turn", () => {
    const el = fakeEl();
    renderHud(el, baseView({ dayVoteTurnPlayerId: "p1" }));
    expect(el.innerHTML).toContain("Your turn to vote");
  });

  it("still shows the (frozen) town budget line alongside the vote-turn line", () => {
    const el = fakeEl();
    renderHud(el, baseView({ dayVoteTurnPlayerId: "p2" }));
    expect(el.innerHTML).toContain("town 20/20");
  });
});
