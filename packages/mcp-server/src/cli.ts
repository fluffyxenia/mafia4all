#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { GameSetupConfig } from "@mafia/shared";
import { GameRuntime } from "./runtime.js";
import { createHttpApp } from "./http-server.js";

function usage(): never {
  // eslint-disable-next-line no-console
  console.error("usage: mafia-server [game-config.json] [port]");
  console.error("  With a config file: creates and starts that game immediately.");
  console.error("  Without one: starts empty, ready for the host console (/admin) to create games.");
  process.exit(1);
}

// A bare numeric first argument means "no config file, just a port".
const firstArgIsPort = process.argv[2] !== undefined && /^\d+$/.test(process.argv[2]);
const configPath = firstArgIsPort ? undefined : process.argv[2];
const port = Number((firstArgIsPort ? process.argv[2] : process.argv[3]) ?? 8787);
if (process.argv[2] === "--help" || process.argv[2] === "-h") usage();

const runtime = new GameRuntime();

if (configPath) {
  const config: GameSetupConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const gameId = runtime.createGame(config);
  const started = runtime.startGame(gameId);
  if (!started.ok) {
    // eslint-disable-next-line no-console
    console.error(`failed to start game: ${started.error}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Game ${gameId} started with ${config.seats.length} seats. Join URLs:`);
  for (const seat of config.seats) {
    const token = runtime.issueToken(gameId, seat.playerId);
    // eslint-disable-next-line no-console
    console.log(`  ${seat.displayName} (${seat.playerId}): http://localhost:${port}/mcp/${token}`);
  }
} else {
  // eslint-disable-next-line no-console
  console.log("No game config given — waiting for the host console to create one via POST /admin/games.");
}

const app = createHttpApp(runtime, port);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`\nListening on :${port}.`);
});
