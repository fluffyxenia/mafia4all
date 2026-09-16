import { describe, expect, it } from "vitest";
import { GameRuntime } from "../runtime.js";
import { connectAll, connectPlayer, type PlayerClient } from "./test-harness.js";

function seats(n: number) {
  return Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `P${i + 1}` }));
}

/**
 * day_discussion has no pass (see tool-availability.ts) — every alive
 * player must genuinely use up their turns via send_chat before the phase
 * can advance to day_vote. Drives that to completion by always speaking as
 * whoever the state says is currently up, regardless of call order, since
 * turn order is randomized per game.
 */
async function exhaustDayDiscussion(players: Record<string, PlayerClient>): Promise<void> {
  const anyId = Object.keys(players)[0]!;
  for (;;) {
    const view = await players[anyId]!.view();
    if (view.phase !== "day_discussion") return;
    const turnId = view.dayTurnPlayerId as string;
    const result = await players[turnId]!.call("send_chat", { channel: "town", message: "Nothing new from me yet." });
    expect(result.isError).toBeFalsy();
  }
}

/**
 * day_vote is sequential too (see tool-availability.ts) — casts each
 * player's designated vote whenever the state says it's actually their
 * turn, regardless of the map's key order, since turn order is randomized.
 */
async function castVotesInOrder(players: Record<string, PlayerClient>, votesByPlayerId: Record<string, string>): Promise<void> {
  const anyId = Object.keys(players)[0]!;
  for (;;) {
    const view = await players[anyId]!.view();
    if (view.phase !== "day_vote") return;
    const turnId = view.dayVoteTurnPlayerId as string;
    const result = await players[turnId]!.call("cast_vote", { target: votesByPlayerId[turnId]! });
    expect(result.isError).toBeFalsy();
  }
}

/**
 * The post-game debrief owes every seated player (dead or alive) exactly
 * one final message, in original seat order — drains it the same way
 * exhaustDayDiscussion/castVotesInOrder drain their own phases.
 */
async function exhaustDebrief(players: Record<string, PlayerClient>): Promise<void> {
  const anyId = Object.keys(players)[0]!;
  for (;;) {
    const view = await players[anyId]!.view();
    if (view.phase !== "debrief") return;
    const turnId = view.debriefTurnPlayerId as string;
    const result = await players[turnId]!.call("send_chat", { channel: "town", message: "GG, everyone." });
    expect(result.isError).toBeFalsy();
  }
}

describe("MCP integration: full game through real tool calls", () => {
  it("plays night -> day_discussion -> day_vote -> Town win end to end over MCP", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(4),
      roleDistribution: { mafia: 1, sheriff: 1, doctor: 1, town: 1 },
      turnBudgets: { dayDiscussion: 1 },
      rngSeed: 1,
    });
    const started = runtime.startGame(gameId);
    expect(started.ok).toBe(true);

    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const sheriffId = state.players.find((p) => p.role === "sheriff")!.id;
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const players = await connectAll(runtime, gameId, [mafiaId, sheriffId, doctorId, townId]);

    const protect = await players[doctorId]!.call("night_action", {
      actionType: "doctor_protect",
      targetPlayerId: townId,
    });
    expect(protect.isError).toBeFalsy();

    const kill = await players[mafiaId]!.call("night_action", {
      actionType: "mafia_kill_proposal",
      targetPlayerId: townId,
    });
    expect(kill.isError).toBeFalsy();

    const investigate = await players[sheriffId]!.call("night_action", {
      actionType: "sheriff_investigate",
      targetPlayerId: mafiaId,
    });
    expect(investigate.isError).toBeFalsy();

    // The night should have auto-resolved (all actionable roles acted) as
    // part of the last call above — no separate "advance" step needed.
    let view = await players[townId]!.view();
    expect(view.phase).toBe("day_discussion");
    expect(view.self.alive).toBe(true); // doctor's protection held

    await exhaustDayDiscussion(players);

    view = await players[townId]!.view();
    expect(view.phase).toBe("day_vote");

    await castVotesInOrder(players, { [sheriffId]: mafiaId, [doctorId]: mafiaId, [townId]: mafiaId, [mafiaId]: "abstain" });

    view = await players[townId]!.view();
    expect(view.phase).toBe("debrief");
    expect(view.winner.result).toBe("town");

    await exhaustDebrief(players);

    view = await players[townId]!.view();
    expect(view.phase).toBe("post_game");
    expect(view.winner.result).toBe("town");

    // Post-game reveals every channel to everyone, including Mafia's.
    expect(view.chatLog).toBeDefined();
    expect(view.roster.find((r: { id: string }) => r.id === mafiaId).revealedRole).toBe("mafia");
  });

  it("accepts an explicit null on an optional field the same as omitting it entirely", async () => {
    // Regression: a model unsure about an optional field will sometimes
    // emit e.g. `reasoning: null` / `replyToPingId: null` rather than omit
    // the key — z.string().optional() alone rejects that as a schema
    // violation (only undefined is accepted), burning a strike toward the
    // 3-strikes fallback over a field the model never needed to set. See
    // SendChatInput/ReasoningField/NightActionInput's .nullish() in
    // schemas.ts.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(4), roleDistribution: { mafia: 1, town: 3 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const mafia = await connectPlayer(runtime, gameId, mafiaId);
    // A no-op kill target keeps a hostile-vs-town numeric edge alive so the
    // night resolves into day_discussion instead of an immediate win — the
    // point of this test is exercising the null-optional-field path, not
    // the win condition itself.
    const nightResult = await mafia.call("night_action", {
      actionType: "mafia_kill_proposal",
      targetPlayerId: townId,
      reasoning: null,
    });
    expect(nightResult.isError).toBeFalsy();

    const afterNight = runtime.getState(gameId);
    expect(afterNight.phase).toBe("day_discussion");
    const turnId = afterNight.dayTurnQueue[0]!;
    const speaker = await connectPlayer(runtime, gameId, turnId);
    const chatResult = await speaker.call("send_chat", { channel: "town", message: "hi", replyToPingId: null });
    expect(chatResult.isError).toBeFalsy();
  });

  it("hides night_action entirely from a role with no night action, and still blocks calling it directly", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(2),
      roleDistribution: { mafia: 1, town: 1 },
      rngSeed: 3,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const townId = state.players.find((p) => p.role === "town")!.id;

    const town = await connectPlayer(runtime, gameId, townId);
    const tools = await town.client.listTools();
    expect(tools.tools.find((t) => t.name === "night_action")).toBeUndefined();

    // A client that ignores the advertised list and calls it anyway must
    // still be cleanly rejected, not crash the session.
    const result = await town.call("night_action", { actionType: "doctor_protect", targetPlayerId: townId });
    expect(result.isError).toBe(true);
  });

  it("a Mafia player's view includes the mafia channel; a Town player's does not", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(2),
      roleDistribution: { mafia: 1, town: 1 },
      rngSeed: 3,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const mafia = await connectPlayer(runtime, gameId, mafiaId);
    const town = await connectPlayer(runtime, gameId, townId);

    // Deliberately leave mafia's kill proposal unsubmitted: town has no
    // night-actionable role, so submitting it would immediately satisfy
    // night-readiness and auto-resolve (and eventually end) the game before
    // there's anything interesting to inspect.
    await mafia.call("send_chat", { channel: "mafia", message: "hello teammate" });

    const mafiaView = await mafia.view();
    const townView = await town.view();

    expect(mafiaView.visibleChannels).toContain("mafia");
    expect(mafiaView.chatLog.some((m: { channel: string }) => m.channel === "mafia")).toBe(true);

    expect(townView.visibleChannels).not.toContain("mafia");
    expect(townView.chatLog).toHaveLength(0);
  });

  it("narrows send_chat's channel choices to what's actually writable this phase, not everything the player belongs to", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const mafia = await connectPlayer(runtime, gameId, mafiaId);
    const town = await connectPlayer(runtime, gameId, townId);

    // At night: Mafia can only write to their own channel (not town, which
    // is day-only), and Town — who belongs only to town — has no writable
    // channel at all, so send_chat should be absent entirely for them.
    const mafiaTools = await mafia.client.listTools();
    const mafiaSendChat = mafiaTools.tools.find((t) => t.name === "send_chat");
    expect((mafiaSendChat?.inputSchema.properties as Record<string, { enum?: string[] }>)?.channel?.enum).toEqual(["mafia"]);

    const townTools = await town.client.listTools();
    expect(townTools.tools.find((t) => t.name === "send_chat")).toBeUndefined();
  });

  it("a Mafia proposal's reasoning shows up as a real chat message to a teammate", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(3),
      roleDistribution: { mafia: 2, town: 1 },
      rngSeed: 6,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const [mafia1, mafia2] = state.players.filter((p) => p.role === "mafia").map((p) => p.id);
    const town = state.players.find((p) => p.role === "town")!;

    const bob = await connectPlayer(runtime, gameId, mafia1!);
    const cara = await connectPlayer(runtime, gameId, mafia2!);

    const result = await bob.call("night_action", {
      actionType: "mafia_kill_proposal",
      targetPlayerId: town.id,
      reasoning: "They keep deflecting every question.",
    });
    expect(result.isError).toBeFalsy();

    const caraView = await cara.view();
    const proposal = caraView.chatLog.find((m: { authorId: string }) => m.authorId === mafia1);
    // Reasoning replaces the generic default statement entirely when given.
    expect(proposal?.message).toBe("They keep deflecting every question.");
  });

  it("uses the target's display name (not their internal id) in the generic default statement", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(3),
      roleDistribution: { mafia: 2, town: 1 },
      rngSeed: 6,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const [mafia1, mafia2] = state.players.filter((p) => p.role === "mafia").map((p) => p.id);
    const town = state.players.find((p) => p.role === "town")!;

    const bob = await connectPlayer(runtime, gameId, mafia1!);
    const cara = await connectPlayer(runtime, gameId, mafia2!);

    // No reasoning given, so this falls back to the generic default statement.
    const result = await bob.call("night_action", { actionType: "mafia_kill_proposal", targetPlayerId: town.id });
    expect(result.isError).toBeFalsy();

    const caraView = await cara.view();
    const proposal = caraView.chatLog.find((m: { authorId: string }) => m.authorId === mafia1);
    expect(proposal?.message).toBe(`Locked in on ${town.displayName}.`);
  });

  it("the morning-after death announcement names the victim by display name, not their internal id", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(3),
      roleDistribution: { mafia: 1, town: 2 },
      rngSeed: 6,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const victim = state.players.find((p) => p.role === "town")!;

    const mafia = await connectPlayer(runtime, gameId, mafiaId);
    await mafia.call("night_action", { actionType: "mafia_kill_proposal", targetPlayerId: victim.id });

    const view = await mafia.view();
    // Two system lines now: the Mafia-association reveal (added in
    // apply-deaths.ts for every death) plus this morning's own death
    // announcement — check both rather than assuming there's only one.
    const announcements = view.chatLog
      .filter((m: { system?: boolean }) => m.system)
      .map((m: { message: string }) => m.message);
    expect(announcements).toContain(`${victim.displayName} was found dead this morning.`);
    expect(announcements).toContain(`${victim.displayName} was not Mafia.`);
    for (const message of announcements) expect(message).not.toContain(victim.id);
  });

  it("advertises the reasoning field on night_action and cast_vote via the real tools/list response", async () => {
    // Four seats (not two) so the night's one kill doesn't itself end the
    // game before day_vote is reached: night_action and cast_vote are only
    // ever advertised in their own phase now, so this test has to actually
    // walk the game there rather than inspecting a static tool list.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: seats(4),
      roleDistribution: { mafia: 1, town: 3 },
      turnBudgets: { dayDiscussion: 1 },
      rngSeed: 3,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const [victimId, survivorA, survivorB] = state.players.filter((p) => p.role === "town").map((p) => p.id);

    const mafia = await connectPlayer(runtime, gameId, mafiaId);
    const townA = await connectPlayer(runtime, gameId, survivorA!);
    const townB = await connectPlayer(runtime, gameId, survivorB!);

    const nightTools = await mafia.client.listTools();
    const nightAction = nightTools.tools.find((t) => t.name === "night_action");
    expect((nightAction?.inputSchema.properties as Record<string, unknown>)?.reasoning).toBeDefined();

    await mafia.call("night_action", { actionType: "mafia_kill_proposal", targetPlayerId: victimId });
    const players = { [mafiaId]: mafia, [survivorA!]: townA, [survivorB!]: townB };
    await exhaustDayDiscussion(players);

    const view = await townA.view();
    expect(view.phase).toBe("day_vote");

    // cast_vote is sequential now (see tool-availability.ts) — only whoever
    // the state says is currently up actually has it in their tool list.
    const currentVoter = players[view.dayVoteTurnPlayerId as string]!;
    const dayTools = await currentVoter.client.listTools();
    const castVote = dayTools.tools.find((t) => t.name === "cast_vote");
    expect((castVote?.inputSchema.properties as Record<string, unknown>)?.reasoning).toBeDefined();
  });

  it("no tool's input schema uses minLength/maxLength on any field", async () => {
    // Some local llama.cpp builds' GBNF grammar converter for tool calling
    // fails outright ("failed to parse grammar") on JSON Schema
    // minLength/maxLength, which would silently break every tool but
    // `pass` for local-model players. Length caps are enforced in plain JS
    // in the reducer instead — this locks in that none crept back into a
    // wire schema.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 3 });
    runtime.startGame(gameId);
    const townId = runtime.getState(gameId).players.find((p) => p.role === "town")!.id;
    const town = await connectPlayer(runtime, gameId, townId);

    const tools = await town.client.listTools();
    for (const tool of tools.tools) {
      const json = JSON.stringify(tool.inputSchema);
      expect(json, `${tool.name} inputSchema must not use minLength/maxLength`).not.toMatch(
        /"(minLength|maxLength)"/,
      );
    }
  });
});
