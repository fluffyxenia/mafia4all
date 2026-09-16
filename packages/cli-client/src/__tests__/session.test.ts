import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameRuntime, createPlayerMcpServer } from "@mafia/mcp-server";
import { CliSession } from "../session.js";

async function connectClient(runtime: GameRuntime, gameId: string, playerId: string) {
  const server = createPlayerMcpServer(runtime, gameId, playerId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `cli-${playerId}`, version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function capture(): { output: PassThrough; text: () => string } {
  const output = new PassThrough();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
  });
  return { output, text: () => buffer };
}

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CliSession", () => {
  it("prints an initial summary and the help text on start", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { mafia: 1, town: 1 },
      rngSeed: 5,
    });
    runtime.startGame(gameId);
    const townId = runtime.getState(gameId).players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, townId);
    const input = new PassThrough();
    const { output, text } = capture();
    const session = new CliSession({ client, input, output });

    const done = session.start();
    await wait();
    expect(text()).toContain(`You are ${townId} (town)`);
    expect(text()).toContain("Commands:");

    input.end();
    await done;
  });

  it("sends a bare line as chat to the default channel and echoes it back", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [
        { playerId: "p1", displayName: "P1" },
        { playerId: "p2", displayName: "P2" },
        { playerId: "p3", displayName: "P3" },
      ],
      roleDistribution: { mafia: 1, doctor: 1, town: 1 },
      rngSeed: 5,
    });
    runtime.startGame(gameId);
    const state = runtime.getState(gameId);
    const mafiaId = state.players.find((p) => p.role === "mafia")!.id;
    const doctorId = state.players.find((p) => p.role === "doctor")!.id;
    const townId = state.players.find((p) => p.role === "town")!.id;

    // Drive the night to resolution directly so the CLI player under test
    // starts in day_discussion, where bare chat has a default channel.
    runtime.applyPlayerCommand(gameId, {
      type: "night_action",
      playerId: doctorId,
      actionType: "doctor_protect",
      targetPlayerId: townId,
    });
    runtime.applyPlayerCommand(gameId, {
      type: "night_action",
      playerId: mafiaId,
      actionType: "mafia_kill_proposal",
      targetPlayerId: townId,
    });
    expect(runtime.getState(gameId).phase).toBe("day_discussion");

    const client = await connectClient(runtime, gameId, townId);
    const input = new PassThrough();
    const { output, text } = capture();
    const session = new CliSession({ client, input, output });

    const done = session.start();
    await wait();

    input.write("hello everyone\n");
    await wait();
    expect(text()).toContain(`[town] ${townId}: hello everyone`);
    expect(text()).not.toContain("error:");

    input.end();
    await done;
  });

  it("rejects an unwritable-channel attempt cleanly (no channel available at night for a solo role)", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { mafia: 1, sheriff: 1 },
      rngSeed: 8,
    });
    runtime.startGame(gameId);
    const sheriffId = runtime.getState(gameId).players.find((p) => p.role === "sheriff")!.id;

    const client = await connectClient(runtime, gameId, sheriffId);
    const input = new PassThrough();
    const { output, text } = capture();
    const session = new CliSession({ client, input, output });

    const done = session.start();
    await wait();

    input.write("anyone home?\n");
    await wait();
    expect(text()).toContain("no writable channel right now");

    input.end();
    await done;
  });

  it("/quit prints a farewell and triggers onClose", async () => {
    const runtime = new GameRuntime();
    const gameId = runtime.createGame({
      seats: [{ playerId: "p1", displayName: "P1" }, { playerId: "p2", displayName: "P2" }],
      roleDistribution: { mafia: 1, town: 1 },
      rngSeed: 5,
    });
    runtime.startGame(gameId);
    const townId = runtime.getState(gameId).players.find((p) => p.role === "town")!.id;

    const client = await connectClient(runtime, gameId, townId);
    const input = new PassThrough();
    const { output, text } = capture();
    let closed = false;
    const session = new CliSession({ client, input, output, onClose: () => (closed = true) });

    const done = session.start();
    await wait();
    input.write("/quit\n");
    await wait();
    expect(text()).toContain("bye.");
    expect(closed).toBe(true);

    input.end();
    await done;
  });
});
