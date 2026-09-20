import { describe, expect, it } from "vitest";
import { describeTurn, shouldPrompt } from "../describe-state.js";
import type { PlayerView } from "../view-types.js";

function baseView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: "p1",
    phase: "day_discussion",
    dayNumber: 1,
    self: { role: "town", alignment: "town", alive: true },
    roleDistribution: { mafia: 3, town: 6, sheriff: 1, doctor: 1, vigilante: 1, tanner: 1 },
    roster: [{ id: "p1", displayName: "P1", alive: true }],
    visibleChannels: ["town"],
    chatLog: [],
    privateLog: [],
    pingCredits: 0,
    turnBudgets: [{ channel: "town", used: 0, cap: 5, canSend: true }],
    ...overrides,
  };
}

describe("describeTurn", () => {
  it("includes phase, role, roster, and a call to action", () => {
    const text = describeTurn(undefined, baseView());
    expect(text).toContain("Day 1 discussion");
    expect(text).toContain("town");
    expect(text).toContain("Roster: P1 (p1)");
    expect(text).toContain("call exactly one tool");
  });

  it("labels night as 'Night N', not the internally-consistent-but-confusing 'Day N, phase: night'", () => {
    // Regression: found in real testing — a model got stuck in a visible
    // reasoning loop specifically confused by "Day 2, phase: night" reading
    // as contradictory (dayNumber increments the instant night begins, so
    // Night 2 precedes Day 2's discussion — internally correct, but not
    // obvious from that phrasing alone).
    const text = describeTurn(undefined, baseView({ phase: "night", dayNumber: 2 }));
    expect(text).toContain("Night 2.");
    expect(text).not.toContain("Day 2");
  });

  it("labels day_vote distinctly from day_discussion", () => {
    const text = describeTurn(undefined, baseView({ phase: "day_vote", dayNumber: 3 }));
    expect(text).toContain("Day 3 vote.");
  });

  it("shows the full transcript every turn, marking only what's new since the previous view", () => {
    // Regression: this used to show only the delta since the player's own
    // last turn, nothing older. In real testing that meant a player could
    // go several of their own turns without ever seeing an earlier pivotal
    // message (another player's self-incriminating public statement) if a
    // different, more recent message happened to occupy that turn's "new
    // chat" window instead — the old message then vanished from view
    // entirely, since each turn is a fresh, stateless prompt with no memory
    // of its own past turns (see AgentLoop).
    const prev = baseView({
      chatLog: [{ id: "m1", channel: "town", authorId: "p2", message: "hi", day: 1, phase: "day_discussion" }],
    });
    const next = baseView({
      chatLog: [
        ...prev.chatLog,
        { id: "m2", channel: "town", authorId: "p3", message: "suspicious...", day: 1, phase: "day_discussion" },
      ],
    });
    const text = describeTurn(prev, next);
    // Old message: still present (full transcript), unmarked.
    expect(text).toContain("[town] p2: hi");
    // New message: present and flagged.
    expect(text).toContain("[town] p3 [NEW]: suspicious...");
  });

  it("states remaining turn count directly instead of a bare used/cap pair", () => {
    // Regression: the old "town: 0/3" phrasing under a "remaining turns"
    // label read as ambiguous to several real models in testing (some
    // interpreted "0/3" as "0 remaining" and reasoned themselves out of
    // using a tool that was genuinely available) — the count must be
    // spelled out so there's nothing left to misread.
    const text = describeTurn(undefined, baseView({ turnBudgets: [{ channel: "town", used: 0, cap: 3, canSend: true }] }));
    expect(text).toContain("town: 3 remaining (0 used of 3, shared by the whole table)");
  });

  it("clarifies that town's budget is a shared pool, but leaves other channels unlabeled", () => {
    const text = describeTurn(
      undefined,
      baseView({ turnBudgets: [{ channel: "mafia", used: 0, cap: 6, canSend: true }] }),
    );
    expect(text).toContain("mafia: 6 remaining (0 used of 6)");
    expect(text).not.toContain("shared by the whole table");
  });

  it("labels the post-game debrief distinctly and says whose turn it is, dead or alive", () => {
    const text = describeTurn(
      undefined,
      baseView({
        phase: "debrief",
        self: { role: "town", alignment: "town", alive: false },
        debriefTurnPlayerId: "p1",
        winner: { result: "mafia", winningPlayerIds: ["p2"] },
      }),
    );
    expect(text).toContain("Post-game debrief.");
    expect(text).toContain("DEAD");
    expect(text).toContain("It's your turn to give your final word.");
    expect(text).toContain("GAME OVER: mafia wins (p2)");
  });

  it("tells a waiting player whose turn it is during debrief", () => {
    const text = describeTurn(
      undefined,
      baseView({
        phase: "debrief",
        debriefTurnPlayerId: "p2",
        roster: [
          { id: "p1", displayName: "P1", alive: true },
          { id: "p2", displayName: "P2", alive: true },
        ],
      }),
    );
    expect(text).toContain("It's P2 (p2) turn to give their final word — wait for your turn.");
  });

  it("surfaces the game-over line once a winner is set", () => {
    const text = describeTurn(undefined, baseView({ winner: { result: "town", winningPlayerIds: ["p1"] } }));
    expect(text).toContain("GAME OVER: town wins (p1)");
  });
});

describe("shouldPrompt", () => {
  it("always prompts on the very first turn", () => {
    expect(shouldPrompt(undefined, baseView(), 0, 30_000)).toBe(true);
  });

  it("prompts when the phase changes", () => {
    const prev = baseView({ phase: "night" });
    expect(shouldPrompt(prev, baseView({ phase: "day_discussion" }), 0, 30_000)).toBe(true);
  });

  it("prompts when new chat has arrived outside day_discussion (e.g. Mafia coordinating at night)", () => {
    const prev = baseView({ phase: "night" });
    const next = baseView({
      phase: "night",
      chatLog: [{ id: "m1", channel: "mafia", authorId: "p2", message: "hi", day: 1, phase: "night" }],
    });
    expect(shouldPrompt(prev, next, 0, 30_000)).toBe(true);
  });

  it("prompts on new town chat during day_discussion once it becomes this player's turn", () => {
    const prev = baseView({ dayTurnPlayerId: "p2" });
    const next = baseView({
      dayTurnPlayerId: "p1",
      chatLog: [{ id: "m1", channel: "town", authorId: "p2", message: "hi", day: 1, phase: "day_discussion" }],
    });
    expect(shouldPrompt(prev, next, 0, 30_000)).toBe(true);
  });

  it("does not prompt on new town chat during day_discussion while it's still someone else's turn", () => {
    // Turn order means send_chat/ping_player for "town" won't even be in
    // this player's tool list yet — burning a slow inference call here
    // would only relearn "still not your turn" (or worse, risk the model
    // reaching for the only tool left, `pass`, and wrongly giving up its
    // turns for the rest of the day).
    const prev = baseView({ dayTurnPlayerId: "p2" });
    const next = baseView({
      dayTurnPlayerId: "p3",
      chatLog: [{ id: "m1", channel: "town", authorId: "p2", message: "hi", day: 1, phase: "day_discussion" }],
    });
    expect(shouldPrompt(prev, next, 0, 30_000)).toBe(false);
  });

  it("does not prompt when nothing changed and the idle window hasn't elapsed", () => {
    const view = baseView();
    expect(shouldPrompt(view, view, 1000, 30_000)).toBe(false);
  });

  it("prompts once the idle-nudge window elapses even with no changes", () => {
    const view = baseView();
    expect(shouldPrompt(view, view, 31_000, 30_000)).toBe(true);
  });

  it("idle-nudges even after nothing has changed since the view's own alreadyActedTonight snapshot", () => {
    // Regression: shouldPrompt used to take a 5th "alreadyActedThisPhase"
    // flag and refuse to idle-nudge at all once it was true — the idea
    // being a submitted night_action/vote/etc. leaves nothing left to nudge
    // about. That was wrong once mafia/deep_divers/lovers got turn-gated
    // chat: a player can submit their night_action and still have a
    // separate, not-yet-taken send_chat turn queued behind it — found in
    // real testing as a permanently stuck channel turn queue (the
    // committed player was never re-prompted for their still-pending chat
    // turn, freezing everyone queued behind them for the rest of the
    // night). The real protection against a wasted/harmful re-prompt is
    // AgentLoop's own hasRealTool check (backed by tool-availability.ts's
    // per-tool state gating) *before* this is ever called, not a flag here
    // — so this only needs to answer "has idle time actually elapsed."
    const view = baseView({ phase: "night" });
    expect(shouldPrompt(view, view, 31_000, 30_000)).toBe(true);
  });

  it("still prompts on real news (new chat) well before the idle window elapses", () => {
    const prev = baseView({ phase: "night" });
    const next = baseView({
      phase: "night",
      chatLog: [{ id: "m1", channel: "mafia", authorId: "p2", message: "hi", day: 1, phase: "night" }],
    });
    expect(shouldPrompt(prev, next, 0, 30_000)).toBe(true);
  });
});
