import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameRuntime, createPlayerMcpServer } from "@mafia/mcp-server";
import { AgentLoop } from "../agent-loop.js";
import { ScriptedAdapter } from "../llm/stub-adapter.js";

async function connectClient(runtime: GameRuntime, gameId: string, playerId: string) {
  const server = createPlayerMcpServer(runtime, gameId, playerId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `agent-${playerId}`, version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("AgentLoop", () => {
  it("invokes the real MCP tool the scripted LLM chose, and fetches the tool list dynamically", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    const llm = new ScriptedAdapter([
      {
        toolCall: {
          id: "c1",
          name: "night_action",
          arguments: { actionType: "doctor_protect", targetPlayerId: townId },
        },
      },
    ]);
    const logs: string[] = [];
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, onLog: (l) => logs.push(l) });

    // This game has no hostile role at all (doctor + town only), so it ends
    // as an immediate Town win the instant the doctor's action resolves —
    // straight into the post-game debrief (see win-conditions.ts). Full
    // resolution to the truly-terminal post_game needs every seated
    // player's debrief turn taken (townId's loop isn't running here), so
    // rather than await run() itself resolving, stop it once the doctor's
    // one scripted action has landed — same pattern as every other
    // multi-tick test below. doctorId (p2) is second in debrief queue order
    // (townId/p1 is first) for this rngSeed, so it never gets re-prompted
    // for a real second action in this window regardless of wait length.
    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await runPromise;

    const recorded = runtime.getState(gameId).nightActions.find((a) => a.actorId === doctorId);
    expect(recorded).toMatchObject({ actionType: "doctor_protect", targetId: townId });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.tools.map((t) => t.name)).toContain("night_action");
    expect(logs.some((l) => l.includes("night_action") && l.includes("ok"))).toBe(true);
    expect(runtime.getState(gameId).phase).toBe("debrief");
    expect(runtime.getState(gameId).winner?.result).toBe("town");
  });

  it("reports each LLM decision via onTurn with the exact input and output paired together", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    const llm = new ScriptedAdapter([
      {
        toolCall: {
          id: "c1",
          name: "night_action",
          arguments: { actionType: "doctor_protect", targetPlayerId: townId },
        },
      },
    ]);
    const turns: unknown[] = [];
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, onTurn: (r) => turns.push(r) });

    // Same reasoning as the test above: the immediate Town win moves the
    // game into debrief, not straight to post_game, and townId's loop isn't
    // running here to ever finish it — stop manually once the scripted
    // action has landed. doctorId (p2) sits second in the debrief queue for
    // this rngSeed, so it's never re-prompted for a real second turn.
    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await runPromise;

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      playerId: doctorId,
      phase: "night",
      tools: expect.arrayContaining([expect.objectContaining({ name: "night_action" })]),
      result: { toolCall: { name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } } },
    });
  });

  it("falls back to pass when the scripted script is exhausted, instead of hanging", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }, { playerId: "p3", displayName: "P3" }],
      roleDistribution: { mafia: 1, town: 2 },
      rngSeed: 11,
    });
    runtime.startGame(gameId);
    const mafiaId = runtime.getState(gameId).players.find((p) => p.role === "mafia")!.id;

    const client = await connectClient(runtime, gameId, mafiaId);
    const llm = new ScriptedAdapter([]); // empty script -> every call falls back to `pass`
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 10, idleNudgeMs: 5 });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 60));
    loop.stop();
    await runPromise;

    expect(llm.calls.length).toBeGreaterThan(0);
    const record = runtime.getState(gameId).nightActions.find((a) => a.actorId === mafiaId);
    expect(record?.actionType).toBe("pass");
  });

  it("does not re-prompt (or overwrite an already-committed night action) once the idle-nudge window elapses again", async () => {
    // Regression test: night stays open the whole test (mafia never acts,
    // so it can't auto-resolve), with an aggressively short idle-nudge —
    // if this regresses, the idle-nudge fires repeatedly despite nothing
    // having changed, burning wasted LLM calls and, worse, letting the
    // scripted adapter's exhausted-script fallback (`pass`) silently
    // overwrite the doctor's already-committed protection. This is no
    // longer protected by a "committedThisPhase" flag in shouldPrompt
    // (removed — see describe-state.test.ts) — it's protected by
    // tool-availability.ts correctly reporting no real tool left for a
    // plain doctor (not in any team channel) once their one-shot
    // night_action is used, which AgentLoop's own hasRealTool check turns
    // into "don't even ask."
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
      ],
      roleDistribution: { doctor: 1, mafia: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    const llm = new ScriptedAdapter([
      { toolCall: { id: "c1", name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } } },
    ]);
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 10, idleNudgeMs: 5 });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    loop.stop();
    await runPromise;

    expect(llm.calls).toHaveLength(1);
    const recorded = runtime.getState(gameId).nightActions.find((a) => a.actorId === doctorId);
    expect(recorded).toMatchObject({ actionType: "doctor_protect", targetId: townId });
  });

  it("re-prompts a mafia player for their still-pending team-channel chat turn even after their night_action already committed", async () => {
    // Regression: found live — a mafia player submitted their
    // mafia_kill_proposal, and once their turn to actually *speak* in the
    // mafia channel came up afterward, they were never re-prompted at all,
    // permanently freezing everyone queued behind them for the rest of the
    // night. Root cause was shouldPrompt's old "already committed this
    // phase" flag treating a night_action as "nothing left to do all
    // night" — true before mafia/deep_divers/lovers chat was turn-gated,
    // false now that a night_action and a separate chat turn can both be
    // outstanding at once.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
        { playerId: "p4", displayName: "P4" },
      ],
      roleDistribution: { mafia: 2, town: 2 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const townId = state.players.find((p) => p.role === "town")!.id;
    const [firstMafiaId, secondMafiaId] = state.channelTurnQueues.mafia!;

    // secondMafiaId submits its night_action first, well before its own
    // chat turn (firstMafiaId is up first) — this is the "committed but
    // still has a pending chat turn" state the bug froze forever.
    const client = await connectClient(runtime, gameId, secondMafiaId!);
    const llm = new ScriptedAdapter([
      { toolCall: { id: "c1", name: "night_action", arguments: { actionType: "mafia_kill_proposal", targetPlayerId: townId } } },
      { toolCall: { id: "c2", name: "send_chat", arguments: { channel: "mafia", message: "agreed, let's go with that" } } },
    ]);
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 10, idleNudgeMs: 5 });
    const runPromise = loop.run();

    // Give it time to submit the night_action and confirm it does NOT yet
    // have a chat turn (firstMafiaId hasn't spoken, so the queue hasn't
    // advanced to secondMafiaId).
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(llm.calls).toHaveLength(1);
    expect(runtime.getState(gameId).nightActions.find((a) => a.actorId === secondMafiaId)).toMatchObject({
      actionType: "mafia_kill_proposal",
    });

    // Now firstMafiaId takes their real chat turn via a raw tool call
    // (bypassing AgentLoop — simulating a teammate, not the player under
    // test), which should advance the mafia channel's turn to secondMafiaId.
    const firstMafiaClient = await connectClient(runtime, gameId, firstMafiaId!);
    await firstMafiaClient.callTool({ name: "send_chat", arguments: { channel: "mafia", message: "let's target them" } });

    // secondMafiaId's AgentLoop should now get re-prompted for its own
    // pending chat turn despite already having committed a night_action.
    await new Promise((resolve) => setTimeout(resolve, 80));
    loop.stop();
    await runPromise;

    expect(llm.calls).toHaveLength(2);
    const mafiaChat = runtime.getState(gameId).chatLog.filter((m) => m.channel === "mafia" && m.authorId === secondMafiaId);
    expect(mafiaChat.some((m) => m.message === "agreed, let's go with that")).toBe(true);
  });

  it("never prompts a day_discussion player whose only tool is pass (not their turn yet)", async () => {
    // Regression test: `pass` is deliberately available to any alive player
    // during day_discussion regardless of turn order (it means "opt out of
    // all my remaining turns", not "decline my current turn" — see
    // reducer.ts's handlePass), so a not-my-turn player's tool list is
    // exactly `[pass]`, non-empty. Before this fix, that satisfied the old
    // `tools.length > 0` gate, so the idle-nudge alone would eventually
    // prompt them — risking the model reaching for the only tool it sees
    // and wrongly giving up every remaining turn for a day that hadn't
    // reached it yet.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
      ],
      roleDistribution: { mafia: 1, doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    // Resolve the night directly via raw tool calls (bypassing AgentLoop for
    // setup) so the game actually reaches day_discussion.
    const setupDoctor = await connectClient(runtime, gameId, doctorId);
    await setupDoctor.callTool({
      name: "night_action",
      arguments: { actionType: "doctor_protect", targetPlayerId: townId },
    });
    const setupMafia = await connectClient(runtime, gameId, mafiaId);
    await setupMafia.callTool({
      name: "night_action",
      arguments: { actionType: "mafia_kill_proposal", targetPlayerId: townId },
    });

    const afterNight = runtime.getState(gameId);
    expect(afterNight.phase).toBe("day_discussion");
    const currentTurnId = afterNight.dayTurnQueue[0];
    const notMyTurnId = [mafiaId, doctorId, townId].find((id) => id !== currentTurnId)!;

    const client = await connectClient(runtime, gameId, notMyTurnId);
    const llm = new ScriptedAdapter([]); // any call here would be a bug — nothing to script
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 10, idleNudgeMs: 5 });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await runPromise;

    expect(llm.calls).toHaveLength(0);
  });

  it("survives a failed/timed-out LLM call instead of crashing the whole loop", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const doctorId = runtime.getState(gameId).players.find((p) => p.role === "doctor")!.id;
    const townId = runtime.getState(gameId).players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    let calls = 0;
    const llm = {
      async complete() {
        calls += 1;
        if (calls === 1) throw new Error("simulated network/timeout failure");
        return {
          toolCall: {
            id: "c1",
            name: "night_action",
            arguments: { actionType: "doctor_protect", targetPlayerId: townId },
          },
        };
      },
    };
    const logs: string[] = [];
    // idleNudgeMs is tiny so the retry after the failed first call fires
    // quickly rather than waiting out the default 30s idle window.
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, idleNudgeMs: 5, onLog: (l) => logs.push(l) });

    // Should not throw despite the first complete() call failing. As above,
    // the immediate Town win lands in debrief (not post_game) with
    // townId's loop not running to finish it, so stop manually rather than
    // awaiting natural resolution; doctorId (p2) is second in debrief queue
    // order for this rngSeed, so no unwanted real second call in this window.
    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await expect(runPromise).resolves.toBeUndefined();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes("LLM request failed"))).toBe(true);
    const recorded = runtime.getState(gameId).nightActions.find((a) => a.actorId === doctorId);
    expect(recorded).toMatchObject({ actionType: "doctor_protect", targetId: townId });
  });

  it("survives a failed view/tool-list fetch instead of crashing the whole loop", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const doctorId = runtime.getState(gameId).players.find((p) => p.role === "doctor")!.id;
    const townId = runtime.getState(gameId).players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    // Simulate a dropped connection/server hiccup on the very first
    // resource read — a plain MCP request, not an LLM call — and confirm
    // it's recovered from on the next poll rather than rejecting run().
    const realReadResource = client.readResource.bind(client);
    let readCalls = 0;
    client.readResource = (async (...args: Parameters<typeof realReadResource>) => {
      readCalls += 1;
      if (readCalls === 1) throw new Error("simulated transport failure");
      return realReadResource(...args);
    }) as typeof client.readResource;

    const llm = new ScriptedAdapter([
      {
        toolCall: {
          id: "c1",
          name: "night_action",
          arguments: { actionType: "doctor_protect", targetPlayerId: townId },
        },
      },
    ]);
    const logs: string[] = [];
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, onLog: (l) => logs.push(l) });

    // Same reasoning as the previous two tests: stop manually rather than
    // awaiting natural resolution to post_game, which needs townId's
    // (not-running) loop to also finish its debrief turn.
    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await expect(runPromise).resolves.toBeUndefined();

    expect(readCalls).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes("view/tools fetch failed"))).toBe(true);
    const recorded = runtime.getState(gameId).nightActions.find((a) => a.actorId === doctorId);
    expect(recorded).toMatchObject({ actionType: "doctor_protect", targetId: townId });
  });

  it("forces a blunt error chat message after 3 consecutive failed day_discussion turns, instead of blocking the whole channel forever", async () => {
    // Regression: day_discussion has strictly sequential turns and no
    // `pass` at all — before this, a genuinely broken/dead LLM endpoint
    // would silently retry forever (every poll tick), blocking every other
    // player indefinitely since nobody after this seat in the turn queue
    // can speak until it does. The fallback message is deliberately blunt/
    // system-flavored rather than in-character, so it can't be mistaken for
    // the model actually choosing to say something.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
      ],
      roleDistribution: { mafia: 1, doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const setupDoctor = await connectClient(runtime, gameId, doctorId);
    await setupDoctor.callTool({ name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } });
    const setupMafia = await connectClient(runtime, gameId, mafiaId);
    await setupMafia.callTool({ name: "night_action", arguments: { actionType: "mafia_kill_proposal", targetPlayerId: townId } });

    const afterNight = runtime.getState(gameId);
    expect(afterNight.phase).toBe("day_discussion");
    const currentTurnId = afterNight.dayTurnQueue[0]!;

    const client = await connectClient(runtime, gameId, currentTurnId);
    let calls = 0;
    const llm = {
      async complete() {
        calls += 1;
        throw new Error("simulated provider failure");
      },
    };
    const logs: string[] = [];
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 10, idleNudgeMs: 5, onLog: (l) => logs.push(l) });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    loop.stop();
    await runPromise;

    expect(calls).toBe(3);
    const fallbackMsg = runtime
      .getState(gameId)
      .chatLog.find((m) => m.authorId === currentTurnId && m.message === "error: API failure");
    expect(fallbackMsg).toBeDefined();
    expect(fallbackMsg?.channel).toBe("town");
    expect(logs.some((l) => l.includes("forcing fallback send_chat"))).toBe(true);
  });

  it("forces a legal 'abstain' vote after 3 consecutive rejected day_vote tool calls, instead of blocking every other voter", async () => {
    // Regression: day_vote is also strictly sequential (one voter at a
    // time) — a model that keeps producing a tool call the engine rejects
    // (bad target, stale schema, etc.) would otherwise stall the whole
    // vote indefinitely, same failure shape as the day_discussion case
    // above but via a real-tool-call-rejected path (tool_call_failure)
    // rather than a provider error.
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
      ],
      roleDistribution: { mafia: 1, doctor: 1, town: 1 },
      turnBudgets: { dayDiscussion: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const setupDoctor = await connectClient(runtime, gameId, doctorId);
    await setupDoctor.callTool({ name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } });
    const setupMafia = await connectClient(runtime, gameId, mafiaId);
    await setupMafia.callTool({ name: "night_action", arguments: { actionType: "mafia_kill_proposal", targetPlayerId: townId } });
    expect(runtime.getState(gameId).phase).toBe("day_discussion");

    // Exhaust everyone's single town turn (budget=1) via raw send_chat, in
    // real day turn order, to reach day_vote without scripting an AgentLoop
    // for it.
    for (let i = 0; i < 3; i++) {
      const turnId = runtime.getState(gameId).dayTurnQueue[0]!;
      const c = await connectClient(runtime, gameId, turnId);
      await c.callTool({ name: "send_chat", arguments: { channel: "town", message: "no reads yet" } });
    }
    const afterDiscussion = runtime.getState(gameId);
    expect(afterDiscussion.phase).toBe("day_vote");
    const voteTurnId = afterDiscussion.dayVoteQueue[0]!;

    const client = await connectClient(runtime, gameId, voteTurnId);
    const badVote = { toolCall: { id: "c", name: "cast_vote", arguments: { target: "not-a-real-player" } } };
    const llm = new ScriptedAdapter([badVote, badVote, badVote]);
    const logs: string[] = [];
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 10, idleNudgeMs: 5, onLog: (l) => logs.push(l) });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    loop.stop();
    await runPromise;

    expect(llm.calls).toHaveLength(3);
    const vote = runtime.getState(gameId).votes.find((v) => v.voterId === voteTurnId);
    expect(vote).toMatchObject({ target: "abstain", reasoning: "I failed to tool-call, so I abstained." });
    expect(logs.some((l) => l.includes("forcing fallback cast_vote"))).toBe(true);
  });

  it("appends a worked tool-call example only after a real tool-call failure, not on the first attempt", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    const badProtect = { toolCall: { id: "c", name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: "not-a-real-player" } } };
    const goodProtect = {
      toolCall: { id: "c2", name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } },
    };
    const llm = new ScriptedAdapter([badProtect, goodProtect]);
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, idleNudgeMs: 5 });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await runPromise;

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.messages.some((m) => m.content.includes("<tool_call>"))).toBe(false);
    const secondCallText = llm.calls[1]!.messages.map((m) => m.content).join("\n");
    expect(secondCallText).toContain("<tool_call>");
    expect(secondCallText).toContain('"name":"night_action"');
    // Must instruct the model not to literally copy the placeholder content
    // (regression risk: a model parroting the example's own text verbatim
    // into a real action, same failure family as the verbatim-copying bug
    // caught elsewhere in this project).
    expect(secondCallText.toLowerCase()).toContain("not something to");
    expect(secondCallText.toLowerCase()).toContain("copy");
  });

  it("does not append the tool-call example after a provider error (timeout/network failure) — only after the model actually fails to call a tool", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const doctorId = runtime.getState(gameId).players.find((p) => p.role === "doctor")!.id;
    const townId = runtime.getState(gameId).players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    let calls = 0;
    const llm = {
      async complete(request: { messages: { content: string }[] }) {
        calls += 1;
        if (calls === 1) throw new Error("simulated network/timeout failure");
        // Second call should NOT carry a crutch example — the prior failure
        // was a provider_error, not a tool_call_failure.
        expect(request.messages.some((m) => m.content.includes("<tool_call>"))).toBe(false);
        return {
          toolCall: { id: "c1", name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } },
        };
      },
    };
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, idleNudgeMs: 5 });

    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await expect(runPromise).resolves.toBeUndefined();

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("resets the failure counter on a successful action, so an earlier failure doesn't leave a stale count that later fires a needless fallback", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { doctor: 1, town: 1 },
      rngSeed: 9,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, doctorId);
    const badProtect = { toolCall: { id: "c", name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: "not-a-real-player" } } };
    const goodProtect = {
      toolCall: { id: "c3", name: "night_action", arguments: { actionType: "doctor_protect", targetPlayerId: townId } },
    };
    const llm = new ScriptedAdapter([badProtect, badProtect, goodProtect]);
    const logs: string[] = [];
    const loop = new AgentLoop({ client, llm, pollIntervalMs: 20, idleNudgeMs: 5, onLog: (l) => logs.push(l) });

    // This game has no hostile role (doctor + town only), so it ends as an
    // immediate Town win the instant the doctor's (3rd, successful) action
    // resolves — into debrief, not post_game (see the tests above), so
    // stop manually once the 3rd call has landed rather than awaiting
    // natural resolution.
    const runPromise = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    loop.stop();
    await runPromise;

    expect(llm.calls).toHaveLength(3);
    const recorded = runtime.getState(gameId).nightActions.find((a) => a.actorId === doctorId);
    expect(recorded).toMatchObject({ actionType: "doctor_protect", targetId: townId });
    expect(logs.some((l) => l.includes("forcing fallback"))).toBe(false);
  });
});
