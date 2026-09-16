import { describe, expect, it } from "vitest";
import { ROLES } from "@mafia/shared";
import { buildSystemPrompt } from "../prompts.js";
import type { PlayerView } from "../view-types.js";

function viewFor(role: string, extra: Partial<PlayerView["self"]> = {}): PlayerView {
  return {
    playerId: "p1",
    phase: "night",
    dayNumber: 1,
    self: { role, alignment: "town", alive: true, ...extra },
    roster: [],
    visibleChannels: [],
    chatLog: [],
    privateLog: [],
    pingCredits: 0,
    turnBudgets: [],
  };
}

describe("buildSystemPrompt", () => {
  it("produces a non-empty, role-specific prompt naming the role for every role in the game", () => {
    for (const role of ROLES) {
      const prompt = buildSystemPrompt(viewFor(role));
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toContain("Your role:");
      expect(prompt.toLowerCase()).toContain(role.replace(/_/g, " "));
    }
  });

  it("mentions the Mafia's kill-boomerang risk and coordination via proposals", () => {
    const prompt = buildSystemPrompt(viewFor("mafia"));
    expect(prompt).toContain("mafia_kill_proposal");
    expect(prompt.toLowerCase()).toContain("boomerang");
  });

  it("explicitly tells Mafia not to reveal their role, and states the real majority win condition", () => {
    // Regression: found in real testing — a model (good at instruction
    // following generally) publicly self-outed as Mafia along with both
    // teammates on day one. The base prompt's generic "keep your role
    // secret unless your strategy calls for revealing it" left room for a
    // model to decide revealing was a valid strategic choice; Mafia needs a
    // much harder, role-specific override. The old win-condition line
    // ("every non-Mafia player eliminated") also undersold the actual,
    // more-commonly-triggered mechanic — win-conditions.ts's real check is
    // a numeric majority (town-aligned <= hostile), the exact mirror of
    // what TOWN_PROMPT already correctly told Town about its own loss
    // condition.
    const prompt = buildSystemPrompt(viewFor("mafia"));
    expect(prompt.toLowerCase()).toContain("do not reveal that you are mafia");
    expect(prompt.toLowerCase()).toContain("majority");
  });

  it("appends the personal lover addendum only when the player is paired", () => {
    // The base prompt's role-reference section always mentions the Lovers
    // mechanic in general (heartbreak included) so every player understands
    // it regardless of their own role — this checks the *personal* "you are
    // also a Lover" addendum specifically, not that general reference.
    const solo = buildSystemPrompt(viewFor("town"));
    const paired = buildSystemPrompt(viewFor("town", { loverPairId: "pair0" }));
    expect(solo).not.toContain("You are also a Lover");
    expect(paired).toContain("You are also a Lover");
  });

  it("includes the player's own id so the model knows who it is", () => {
    expect(buildSystemPrompt(viewFor("town"))).toContain('playing as player id "p1"');
  });

  it("instructs the model to use display names in chat, not bare ids, with a concrete wrong/right example", () => {
    // Regression: describeTurn shows "Laguna XS 2.1 (p3)" everywhere, but
    // that alone didn't stop models from still writing "p3" in their own
    // messages — a plain "use display names" instruction wasn't enough
    // either. Found in real testing (a full live game's transcript):
    // models kept writing "p8's investigation of p3..." despite the
    // instruction being right there. Added a concrete wrong/right example
    // pair, since abstract phrasing alone wasn't landing.
    const prompt = buildSystemPrompt(viewFor("town"));
    expect(prompt).toMatch(/display name/i);
    expect(prompt).toContain("targetPlayerId");
    expect(prompt.toLowerCase()).toContain("wrong:");
    expect(prompt.toLowerCase()).toContain("right:");
  });

  it("states which Jack of All Trades charges are already used, not just which exist", () => {
    // Regression: the static role description alone always mentions all
    // three tools ("Sheriff-style... Doctor-style... Vigilante-style"),
    // which in real testing led a model down to only its eliminate charge
    // to still reason "I need to use my Sheriff power" and call the
    // already-spent joat_investigate — it was echoing this prompt's
    // unconditional framing, not the tool schema's narrowed enum.
    const prompt = buildSystemPrompt(
      viewFor("jack_of_all_trades", { joatCharges: { investigate: false, protect: false, eliminate: true } }),
    );
    expect(prompt).toContain("joat_investigate: ALREADY USED");
    expect(prompt).toContain("joat_protect: ALREADY USED");
    expect(prompt).toContain("joat_eliminate: still available");
  });

  it("omits the charge-status line entirely for a role with no joatCharges", () => {
    expect(buildSystemPrompt(viewFor("town"))).not.toContain("charge status");
  });

  it("tells every role the real stakes of a Tanner day-vote win, not just the Tanner themselves", () => {
    // Regression: found live — town-aligned models correctly pattern-matched
    // "Jester/Tanner bait" from general genre knowledge, but voted the
    // suspected Tanner out anyway, because nothing in *their own* system
    // prompt (only TANNER_PROMPT, visible solely to the Tanner) ever told
    // them a Tanner day-vote elimination ends the game as an immediate loss
    // for every other player, not just a wasted vote or a small neutral win.
    for (const role of ["town", "mafia", "sheriff", "vigilante", "tanner"] as const) {
      const prompt = buildSystemPrompt(viewFor(role));
      expect(prompt.toLowerCase()).toContain("the game ends immediately as a loss for every other player");
    }
  });

  it("gives every role the full role-reference rulebook, not just their own role's slice of it", () => {
    const prompt = buildSystemPrompt(viewFor("town"));
    expect(prompt).toContain("Role reference");
    expect(prompt.toLowerCase()).toContain("heartbreak");
    expect(prompt.toLowerCase()).toContain("boomerang");
    expect(prompt.toLowerCase()).toContain("jack of all trades");
  });
});
