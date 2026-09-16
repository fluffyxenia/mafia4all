import { describe, expect, it } from "vitest";
import { GameRuntime } from "../runtime.js";
import { computeToolAvailability } from "../tool-availability.js";

function seats(n: number) {
  return Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `P${i + 1}` }));
}

describe("computeToolAvailability", () => {
  // A JoAT can only submit one action per real night (each night_action call
  // replaces that actor's prior submission for the night, and the sole
  // actionable role acting ends the night immediately in a small game), so
  // spending all three charges genuinely takes three separate nights. Rather
  // than orchestrate a multi-night game just to get there, mutate a
  // real post-start state directly — computeToolAvailability is a pure
  // function of (state, playerId), so this is exactly what it sees on a
  // later night once those charges are actually gone.
  function withJoatCharges(state: ReturnType<GameRuntime["getState"]>, joatId: string, charges: Partial<Record<"investigate" | "protect" | "eliminate", boolean>>) {
    return {
      ...state,
      players: state.players.map((p) => (p.id === joatId ? { ...p, joatCharges: { ...p.joatCharges!, ...charges } } : p)),
    };
  }

  it("only offers a JoAT the night-action types their remaining charges allow", () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(2),
      roleDistribution: { jack_of_all_trades: 1, town: 1 },
      rngSeed: 4,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const joatId = state.players.find((p) => p.role === "jack_of_all_trades")!.id;

    const beforeAny = computeToolAvailability(state, joatId);
    expect(beforeAny.nightAction.enabled).toBe(true);
    expect(new Set(beforeAny.nightAction.allowedActionTypes)).toEqual(
      new Set(["joat_investigate", "joat_protect", "joat_eliminate"]),
    );

    // A JoAT can never learn a target's Serial Killer status — that's the
    // Deep Diver's tool, not the JoAT's — and once a charge is spent it's
    // spent, so joat_investigate should disappear from the offered set
    // entirely rather than staying visible as something that would just
    // fail if called again.
    const afterInvestigateSpent = withJoatCharges(state, joatId, { investigate: false });
    const availability = computeToolAvailability(afterInvestigateSpent, joatId);
    expect(availability.nightAction.allowedActionTypes).not.toContain("joat_investigate");
    expect(new Set(availability.nightAction.allowedActionTypes)).toEqual(new Set(["joat_protect", "joat_eliminate"]));
  });

  it("disables night_action entirely once every JoAT charge is spent", () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(2),
      roleDistribution: { jack_of_all_trades: 1, town: 1 },
      rngSeed: 4,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const joatId = state.players.find((p) => p.role === "jack_of_all_trades")!.id;

    const allSpent = withJoatCharges(state, joatId, { investigate: false, protect: false, eliminate: false });
    const availability = computeToolAvailability(allSpent, joatId);
    expect(availability.nightAction.enabled).toBe(false);
    expect(availability.nightAction.allowedActionTypes).toHaveLength(0);
  });

  it("only offers cast_vote during day_vote, and only night_action during night", () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;

    const atNight = computeToolAvailability(state, mafiaId);
    expect(atNight.castVote).toBe(false);
    expect(atNight.nightAction.enabled).toBe(true);
    // A role with a real night action can still explicitly decline it.
    expect(atNight.pass).toBe(true);
  });

  it("stops offering night_action (and pass) once the player has already acted tonight", () => {
    // Regression: night_action stayed available indefinitely even after a
    // player had already submitted their action for the night, letting a
    // human (or a confused/looping model) keep resubmitting all night, each
    // call silently replacing the prior one. AI seats are separately
    // guarded by AgentLoop's own committedThisPhase, but that's an
    // AgentLoop-only safeguard — a human using the real client has nothing
    // stopping them, which is exactly how this was found in real testing.
    // Three seats (not two) with a second actionable role (doctor) so the
    // night doesn't auto-resolve the instant mafia acts alone — otherwise
    // nightAction.enabled would read false just because the phase itself
    // had already moved on, not because of the fix under test.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(3),
      roleDistribution: { mafia: 1, doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const beforeActing = computeToolAvailability(state, mafiaId);
    expect(beforeActing.nightAction.enabled).toBe(true);

    const result = runtime.applyPlayerCommand(gameId, {
      type: "night_action",
      playerId: mafiaId,
      actionType: "mafia_kill_proposal",
      targetPlayerId: townId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phase).toBe("night"); // doctor hasn't acted yet — night is still open

    const afterActing = computeToolAvailability(result.state, mafiaId);
    expect(afterActing.nightAction.enabled).toBe(false);
    expect(afterActing.nightAction.allowedActionTypes).toHaveLength(0);
    expect(afterActing.pass).toBe(false);
  });

  it("gives a role with no night action nothing to do at night — not even pass", () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const townId = state.players.find((p) => p.role === "town")!.id;

    const availability = computeToolAvailability(state, townId);
    expect(availability.nightAction.enabled).toBe(false);
    expect(availability.nightAction.allowedActionTypes).toHaveLength(0);
    // Regression: `pass` used to be offered to every alive player at night
    // regardless of role, so a plain Town player — who has nothing to
    // decline in the first place — still looked like they had a real tool
    // available. That made a phantom "turn" look real to an AI player,
    // burning an LLM call on a decision that was never actually theirs to
    // make.
    expect(availability.pass).toBe(false);
  });

  it("never offers yourself as a ping target", () => {
    // Regression: ping_player had no self-target check at all. Pinging
    // yourself grants a free reply credit and jumps you to the front of the
    // day's ping queue — an infinite self-sustaining loop that can stall
    // day_discussion forever, since it can never advance until every alive
    // player is genuinely out of turns.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(3), roleDistribution: { mafia: 1, town: 2 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const [a, b, c] = state.players.map((p) => p.id);

    const dayState = { ...state, phase: "day_discussion" as const, dayTurnQueue: [a!, b!, c!], dayPingQueue: [] };
    const availability = computeToolAvailability(dayState, a!);
    expect(availability.pingPlayer.enabled).toBe(true);
    expect(new Set(availability.pingPlayer.allowedTargets)).toEqual(new Set([b, c]));
  });

  it("only offers cast_vote to whoever is currently up in the vote queue", () => {
    // Regression: voting used to be enabled for every alive player the
    // instant day_vote began, so every AI seat's LLM fired simultaneously
    // instead of one at a time.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const [a, b] = state.players.map((p) => p.id);

    const voteState = { ...state, phase: "day_vote" as const, dayVoteQueue: [a!, b!] };
    expect(computeToolAvailability(voteState, a!).castVote).toBe(true);
    expect(computeToolAvailability(voteState, b!).castVote).toBe(false);
  });

  describe("send_chat channel narrowing", () => {
    // Town chat is day-only and mafia chat is night-only, so which channel(s)
    // a player can currently write to depends on both role (channel
    // membership) and phase (writability) together — a plain Town player
    // has no writable channel at night at all, and a Mafia player loses
    // their team channel the moment day starts.
    function withPhase(state: ReturnType<GameRuntime["getState"]>, phase: "night" | "day_discussion") {
      return { ...state, phase };
    }

    it("gives a Mafia player only the mafia channel at night, not town", () => {
      const runtime = new GameRuntime();
      const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
      runtime.startGame(gameId);
      const state = runtime.getState(gameId);
      const mafiaId = state.players.find((p) => p.role === "mafia")!.id;

      const availability = computeToolAvailability(state, mafiaId);
      expect(availability.sendChat.enabled).toBe(true);
      expect(availability.sendChat.allowedChannels).toEqual(["mafia"]);
    });

    it("gives a Town player nothing to send at night", () => {
      const runtime = new GameRuntime();
      const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
      runtime.startGame(gameId);
      const state = runtime.getState(gameId);
      const townId = state.players.find((p) => p.role === "town")!.id;

      const availability = computeToolAvailability(state, townId);
      expect(availability.sendChat.enabled).toBe(false);
      expect(availability.sendChat.allowedChannels).toHaveLength(0);
    });

    it("switches to town-only once it's day, including for Mafia (their team channel closes) — for whoever's turn it is", () => {
      const runtime = new GameRuntime();
      const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
      runtime.startGame(gameId);
      const base = withPhase(runtime.getState(gameId), "day_discussion");
      const mafiaId = base.players.find((p) => p.role === "mafia")!.id;
      const townId = base.players.find((p) => p.role === "town")!.id;

      // Only one of them has the floor at a time — see the day-turn-order
      // tests for the turn mechanic itself; this just confirms mafia's
      // private channel is gone and town is the only option once it's day,
      // for either player once it's actually their turn.
      const mafiaTurn = { ...base, dayTurnQueue: [mafiaId, townId] };
      expect(computeToolAvailability(mafiaTurn, mafiaId).sendChat.allowedChannels).toEqual(["town"]);
      expect(computeToolAvailability(mafiaTurn, townId).sendChat.allowedChannels).toHaveLength(0);

      const townTurn = { ...base, dayTurnQueue: [townId, mafiaId] };
      expect(computeToolAvailability(townTurn, townId).sendChat.allowedChannels).toEqual(["town"]);
      expect(computeToolAvailability(townTurn, mafiaId).sendChat.allowedChannels).toHaveLength(0);
    });
  });

  describe("debrief phase", () => {
    it("offers send_chat(town) only to whoever's at the front of the debrief queue — even if they're dead", () => {
      const runtime = new GameRuntime();
      const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
      runtime.startGame(gameId);
      const base = runtime.getState(gameId);
      const [p1, p2] = base.players.map((p) => p.id) as [string, string];
      const state = {
        ...base,
        phase: "debrief" as const,
        debriefQueue: [p1, p2],
        players: base.players.map((p) => (p.id === p1 ? { ...p, alive: false } : p)),
      };

      const front = computeToolAvailability(state, p1);
      expect(front.sendChat.enabled).toBe(true);
      expect(front.sendChat.allowedChannels).toEqual(["town"]);

      const waiting = computeToolAvailability(state, p2);
      expect(waiting.sendChat.enabled).toBe(false);
    });

    it("offers nothing else during debrief — no vote, night action, ping, pass, or jester revenge", () => {
      const runtime = new GameRuntime();
      const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
      runtime.startGame(gameId);
      const base = runtime.getState(gameId);
      const [p1] = base.players.map((p) => p.id) as [string, string];
      const state = { ...base, phase: "debrief" as const, debriefQueue: [p1] };

      const availability = computeToolAvailability(state, p1);
      expect(availability.pingPlayer.enabled).toBe(false);
      expect(availability.castVote).toBe(false);
      expect(availability.nightAction.enabled).toBe(false);
      expect(availability.jesterRevenge).toBe(false);
      expect(availability.pass).toBe(false);
    });
  });
});
