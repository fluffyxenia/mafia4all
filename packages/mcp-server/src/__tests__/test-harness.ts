import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GameRuntime } from "../runtime.js";
import { createPlayerMcpServer, createSpectatorMcpServer } from "../session.js";

export interface PlayerClient {
  playerId: string;
  client: Client;
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  view: () => Promise<any>;
}

export async function connectPlayer(runtime: GameRuntime, gameId: string, playerId: string): Promise<PlayerClient> {
  const server = createPlayerMcpServer(runtime, gameId, playerId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `test-${playerId}`, version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    playerId,
    client,
    call: async (tool, args = {}) => {
      const result = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      return { isError: result.isError, text: result.content[0]?.text ?? "" };
    },
    view: async () => {
      const result = await client.readResource({ uri: "mafia://me/view" });
      const first = result.contents[0] as { text: string };
      return JSON.parse(first.text);
    },
  };
}

export async function connectAll(runtime: GameRuntime, gameId: string, playerIds: string[]): Promise<Record<string, PlayerClient>> {
  const entries = await Promise.all(playerIds.map(async (id) => [id, await connectPlayer(runtime, gameId, id)] as const));
  return Object.fromEntries(entries);
}

export interface SpectatorClient {
  client: Client;
  view: () => Promise<any>;
}

export async function connectSpectator(runtime: GameRuntime, gameId: string): Promise<SpectatorClient> {
  const server = createSpectatorMcpServer(runtime, gameId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-spectator", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    view: async () => {
      const result = await client.readResource({ uri: "mafia://me/view" });
      const first = result.contents[0] as { text: string };
      return JSON.parse(first.text);
    },
  };
}
