import { describe, expect, it } from "vitest";
import { applyCommand } from "../reducer.js";
import { seat, testState } from "./test-helpers.js";

describe("send_chat", () => {
  it("posts a message to a writable channel the player belongs to", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_discussion", dayTurnQueue: ["a"] });
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "hello" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.chatLog.find((m) => m.authorId === "a")?.message).toBe("hello");
  });

  it("rejects a message longer than the app-level cap (enforced in JS, not the wire schema)", () => {
    const state = testState([seat("a", "town")], { phase: "day_discussion", dayTurnQueue: ["a"] });
    const tooLong = "x".repeat(2001);
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: tooLong });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exceeds 2000 characters/);
  });

  it("accepts a message right at the cap", () => {
    const state = testState([seat("a", "town")], { phase: "day_discussion", dayTurnQueue: ["a"] });
    const atCap = "x".repeat(2000);
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: atCap });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty/whitespace-only message", () => {
    const state = testState([seat("a", "town")], { phase: "day_discussion" });
    const result = applyCommand(state, { type: "send_chat", playerId: "a", channel: "town", message: "   " });
    expect(result.ok).toBe(false);
  });
});

describe("ping_player", () => {
  it("also enforces the app-level message length cap", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_discussion", dayTurnQueue: ["a"] });
    const tooLong = "x".repeat(2001);
    const result = applyCommand(state, { type: "ping_player", playerId: "a", targetPlayerId: "b", message: tooLong });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exceeds 2000 characters/);
  });

  it("rejects pinging yourself", () => {
    // Regression: self-ping grants a free reply credit and re-queues the
    // pinger at the front of the day's ping queue — unchecked, a model that
    // pings itself every turn generates an endless supply of extra turns,
    // and day_discussion can never satisfy dayDiscussionReady (every alive
    // player must be genuinely out of turns) to advance to day_vote.
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_discussion", dayTurnQueue: ["a"] });
    const result = applyCommand(state, { type: "ping_player", playerId: "a", targetPlayerId: "a", message: "hi me" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot ping yourself/);
  });
});

describe("cast_vote turn order", () => {
  it("lets the current voter cast, and advances the queue", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_vote", dayVoteQueue: ["a", "b"] });
    const result = applyCommand(state, { type: "cast_vote", playerId: "a", target: "abstain" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.dayVoteQueue).toEqual(["b"]);
  });

  it("rejects voting out of turn", () => {
    // Regression: voting used to be free-for-all with no turn order at
    // all, so every AI seat's LLM fired the instant day_vote began instead
    // of one at a time.
    const state = testState([seat("a", "town"), seat("b", "town")], { phase: "day_vote", dayVoteQueue: ["b", "a"] });
    const result = applyCommand(state, { type: "cast_vote", playerId: "a", target: "abstain" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not your turn to vote/);
  });
});

describe("night_action role validation", () => {
  // The MCP layer now hides/disables night_action's actionType values a
  // player's role can't use at all (see mcp-server's tool-availability.ts),
  // so this engine-level rejection is the defense-in-depth path a
  // schema-narrowed MCP client should never actually reach in practice —
  // still worth locking in directly, since it's the real security boundary.
  it("rejects an action type the player's role doesn't allow", () => {
    const state = testState([seat("a", "town"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "doctor_protect",
      targetPlayerId: "b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/may not submit/);
  });

  it("rejects a Mafia kill proposal targeting yourself", () => {
    // Regression: found in real testing — a lone Mafia player submitted
    // mafia_kill_proposal targeting themselves, and with only one Mafia
    // vote needed, it "won" trivially and eliminated the whole faction on
    // night 1, ending the game before anyone else had even taken a turn.
    const state = testState([seat("a", "mafia"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "mafia_kill_proposal",
      targetPlayerId: "a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot target yourself/);
  });

  it("rejects a Sheriff investigating themselves", () => {
    const state = testState([seat("a", "sheriff"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "sheriff_investigate",
      targetPlayerId: "a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot target yourself/);
  });

  it("rejects a Deep Diver investigating themselves", () => {
    const state = testState([seat("a", "deep_diver"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "deep_diver_investigate",
      targetPlayerId: "a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot target yourself/);
  });

  it("rejects a Serial Killer targeting themselves", () => {
    const state = testState([seat("a", "serial_killer"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "sk_kill",
      targetPlayerId: "a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot target yourself/);
  });

  it("rejects a Vigilante killing themselves", () => {
    const state = testState([seat("a", "vigilante"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "vigilante_kill",
      targetPlayerId: "a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot target yourself/);
  });

  it("still allows a Doctor to protect themselves — self-protection is a legitimate strategic choice", () => {
    const state = testState([seat("a", "doctor"), seat("b", "town")]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "doctor_protect",
      targetPlayerId: "a",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects protecting the same player two nights in a row, but allows it again once a night has passed", () => {
    // Regression: this used to be a permanent whole-game block (a spec
    // slip carried over from the original design docs) — a Doctor who
    // protected themselves night 1 could never protect themselves again
    // for the rest of the game. The intended rule is a one-night cooldown:
    // disallowed on the immediately following night, fair game again after
    // that (protection is meant to respond to fresh circumstances each
    // night, unlike investigation, where a repeat target would never
    // reveal anything new).
    const state = testState([seat("a", "doctor"), seat("b", "town")]);
    const night1 = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "doctor_protect",
      targetPlayerId: "b",
    });
    expect(night1.ok).toBe(true);
    if (!night1.ok) return;

    const night2 = applyCommand(
      { ...night1.state, dayNumber: 2 },
      { type: "night_action", playerId: "a", actionType: "doctor_protect", targetPlayerId: "b" },
    );
    expect(night2.ok).toBe(false);
    if (night2.ok) return;
    expect(night2.error).toMatch(/protected this player last night/);

    const night3 = applyCommand(
      { ...night1.state, dayNumber: 3 },
      { type: "night_action", playerId: "a", actionType: "doctor_protect", targetPlayerId: "b" },
    );
    expect(night3.ok).toBe(true);
  });

  it("rejects a Sheriff investigating the same target twice across the whole game", () => {
    // Unlike Doctor's one-night cooldown, this is a permanent whole-game
    // block — a target's alignment never changes, so a repeat investigation
    // could never reveal anything new.
    const state = testState([seat("a", "sheriff"), seat("b", "town")]);
    const first = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "sheriff_investigate",
      targetPlayerId: "b",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const secondSameNight = applyCommand(
      { ...first.state, dayNumber: 2 },
      { type: "night_action", playerId: "a", actionType: "sheriff_investigate", targetPlayerId: "b" },
    );
    expect(secondSameNight.ok).toBe(false);
    if (secondSameNight.ok) return;
    expect(secondSameNight.error).toMatch(/already been targeted/);
  });

  it("rejects a Deep Diver investigating the same target twice across the whole game", () => {
    const state = testState([seat("a", "deep_diver"), seat("b", "town")]);
    const first = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "deep_diver_investigate",
      targetPlayerId: "b",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applyCommand(
      { ...first.state, dayNumber: 2 },
      { type: "night_action", playerId: "a", actionType: "deep_diver_investigate", targetPlayerId: "b" },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already been targeted/);
  });

  it("rejects re-submitting a Jack of All Trades charge that's already been used", () => {
    const state = testState([seat("a", "jack_of_all_trades"), seat("b", "town")]);
    const first = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "joat_investigate",
      targetPlayerId: "b",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The charge itself is consumed at resolution time (see night.ts), not
    // by the command handler — simulate that here so this test isn't
    // coupled to exactly where the flag flip happens.
    const afterResolution = {
      ...first.state,
      players: first.state.players.map((p) =>
        p.id === "a" ? { ...p, joatCharges: { ...p.joatCharges!, investigate: false } } : p,
      ),
    };

    const second = applyCommand(
      { ...afterResolution, dayNumber: 2 },
      { type: "night_action", playerId: "a", actionType: "joat_investigate", targetPlayerId: "b" },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already been used/);
  });

  it("allows vigilante_hold with no target", () => {
    const state = testState([seat("a", "vigilante"), seat("b", "town")]);
    const result = applyCommand(state, { type: "night_action", playerId: "a", actionType: "vigilante_hold" });
    expect(result.ok).toBe(true);
  });

  it("rejects a night_action targeting a dead player", () => {
    const state = testState([seat("a", "sheriff"), seat("b", "town", { alive: false })]);
    const result = applyCommand(state, {
      type: "night_action",
      playerId: "a",
      actionType: "sheriff_investigate",
      targetPlayerId: "b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unknown or dead target/);
  });
});

describe("jester_revenge command dispatch", () => {
  function subphaseState() {
    // Two town bystanders (not just one) so killing accuser1 doesn't
    // trivially numeric-tie town survivors to the one remaining Mafia and
    // end the game mid-test — these tests are about jester_revenge/pass
    // dispatch, not win-condition edges.
    return testState(
      [
        seat("jester", "jester", { alive: false }),
        seat("accuser1", "town"),
        seat("accuser2", "mafia"),
        seat("bystander1", "town"),
        seat("bystander2", "town"),
      ],
      {
        phase: "jester_revenge_subphase",
        dayNumber: 1,
        pendingJesterRevenge: { jesterId: "jester", eligibleTargets: ["accuser1", "accuser2"], day: 1 },
      },
    );
  }

  it("lets the eliminated Jester eliminate an eligible accuser", () => {
    const result = applyCommand(subphaseState(), {
      type: "jester_revenge",
      playerId: "jester",
      targetPlayerId: "accuser1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players.find((p) => p.id === "accuser1")!.alive).toBe(false);
    expect(result.state.phase).toBe("night");
  });

  it("rejects a target who did not vote against the Jester", () => {
    const result = applyCommand(subphaseState(), {
      type: "jester_revenge",
      playerId: "jester",
      targetPlayerId: "bystander",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/did not vote against the jester/);
  });

  it("rejects anyone other than the eliminated Jester acting here", () => {
    const result = applyCommand(subphaseState(), {
      type: "jester_revenge",
      playerId: "accuser1",
      targetPlayerId: "accuser2",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only the eliminated jester may act/);
  });

  it("lets the Jester pass to decline revenge", () => {
    const result = applyCommand(subphaseState(), { type: "pass", playerId: "jester" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.pendingJesterRevenge).toBeUndefined();
    expect(result.state.players.every((p) => p.id === "jester" || p.alive)).toBe(true);
  });

  it("rejects anyone other than the eliminated Jester passing here", () => {
    const result = applyCommand(subphaseState(), { type: "pass", playerId: "accuser1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only the eliminated jester may act/);
  });
});
