import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SPECTATOR_PLAYER_ID } from "@mafia/engine";
import { createPlayerMcpServer, createSpectatorMcpServer } from "./session.js";
import { createAdminRouter } from "./admin.js";
import type { GameRuntime } from "./runtime.js";

/**
 * One HTTP endpoint per join token, each token bound to a fixed
 * (gameId, playerId) pair. A player's MCP session is created lazily on
 * their first request and kept alive (stateful, per the MCP session-id
 * header) for the rest of the game.
 */
export function createHttpApp(runtime: GameRuntime, port: number, adminToken?: string): express.Express {
  const app = express();
  // The web client (packages/web-client) is a static browser bundle that
  // may well be served from a different origin than this server (its own
  // dev server, or a different host entirely) — same threat model as a
  // join-token URL already being the only "auth" there is, so open CORS
  // here is no more permissive than the join link itself. mcp-session-id
  // must be explicitly exposed: the browser hides all response headers
  // from JS on a cross-origin request except a small safelist, and the MCP
  // client transport reads this one to keep the session alive.
  app.use(cors({ exposedHeaders: ["mcp-session-id"] }));
  app.use(express.json());

  // Host-console-only: create/start/inspect/stop games. On the default
  // localhost-only bind (see cli.ts), reaching this port at all already
  // means "the host's own machine," so no extra auth is layered on. When
  // the listener is opted into a wider bind, cli.ts generates adminToken
  // and every /admin request must present it — otherwise this route sits
  // on the exact same listener as /mcp/:token and would be reachable by
  // anyone who can reach a join link at all.
  app.use("/admin", createAdminRouter(runtime, `http://localhost:${port}`, adminToken));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp/:token", async (req, res) => {
    const entry = runtime.resolveToken(req.params.token!);
    if (!entry) {
      res.status(401).json({ error: "invalid or expired join token" });
      return;
    }

    const sessionIdHeader = req.header("mcp-session-id");
    let transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          transports.set(sessionId, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server =
        entry.playerId === SPECTATOR_PLAYER_ID
          ? createSpectatorMcpServer(runtime, entry.gameId)
          : createPlayerMcpServer(runtime, entry.gameId, entry.playerId);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp/:token", async (req, res) => {
    const sessionIdHeader = req.header("mcp-session-id");
    const transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;
    if (!transport) {
      res.status(400).json({ error: "no active session for this connection" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  return app;
}
