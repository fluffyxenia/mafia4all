import { describe, expect, it } from "vitest";
import { SPECTATOR_PLAYER_ID } from "@mafia/engine";
import { GameRuntime } from "../runtime.js";
import { connectPlayer, connectSpectator } from "./test-harness.js";

function seats(n: number) {
  return Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `P${i + 1}` }));
}

describe("spectator session", () => {
  it("has no tools at all — read-only, can't act", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({ seats: seats(2), roleDistribution: { mafia: 1, town: 1 }, rngSeed: 1 });
    runtime.startGame(gameId);

    const spectator = await connectSpectator(runtime, gameId);
    const tools = await spectator.client.listTools();
    expect(tools.tools).toHaveLength(0);
  });

  it("sees mafia's private chat and every role, which no player session (other than mafia itself) would", async () => {
    const runtime = new GameRuntime();
    // 4 seats (not 3) so the one night kill doesn't itself end the game —
    // post-game reveals every channel to everyone, which would make this
    // test pass for the wrong reason.
    const gameId = runtime.createGame({ seats: seats(4), roleDistribution: { mafia: 1, town: 3 }, rngSeed: 1 });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    const mafia = await connectPlayer(runtime, gameId, mafiaId);
    await mafia.call("night_action", { actionType: "mafia_kill_proposal", targetPlayerId: townId, reasoning: "easy target" });

    const town = await connectPlayer(runtime, gameId, townId);
    const townView = await town.view();
    expect(townView.visibleChannels).not.toContain("mafia");

    const spectator = await connectSpectator(runtime, gameId);
    const view = await spectator.view();
    expect(view.playerId).toBe(SPECTATOR_PLAYER_ID);
    expect(view.visibleChannels).toContain("mafia");
    expect(view.chatLog.some((m: { message: string }) => m.message === "easy target")).toBe(true);
    expect(view.roster.find((r: { id: string }) => r.id === mafiaId)?.revealedRole).toBe("mafia");
    expect(view.roster.find((r: { id: string }) => r.id === townId)?.revealedRole).toBe("town");
  });
});
