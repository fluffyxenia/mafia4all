#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GameSetupConfig } from "@mafia/shared";
import { GameRuntime } from "./runtime.js";
import { createHttpApp } from "./http-server.js";

function usage(): never {
  // eslint-disable-next-line no-console
  console.error("usage: mafia-server [game-config.json] [port] [--bind=<host>]");
  console.error("  With a config file: creates and starts that game immediately.");
  console.error("  Without one: starts empty, ready for the host console (/admin) to create games.");
  console.error("  --bind=<host>: interface to listen on (default: 127.0.0.1, host-machine-only).");
  console.error("    Pass --bind=0.0.0.0 (or a LAN/public address) to accept remote players; this");
  console.error("    also requires an admin token, generated and printed at startup, on every");
  console.error("    /admin request (header: x-admin-token).");
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) usage();

// --bind is a flag that can appear anywhere; strip it out before doing the
// existing positional (config-path, port) parsing so it doesn't shift them.
const bindArg = rawArgs.find((a) => a === "--bind" || a.startsWith("--bind="));
const positional = rawArgs.filter((a) => a !== bindArg);
const bindHost = bindArg ? (bindArg.includes("=") ? bindArg.slice(bindArg.indexOf("=") + 1) : "0.0.0.0") : "127.0.0.1";

// A bare numeric first argument means "no config file, just a port".
const firstArgIsPort = positional[0] !== undefined && /^\d+$/.test(positional[0]!);
const configPath = firstArgIsPort ? undefined : positional[0];
const port = Number((firstArgIsPort ? positional[0] : positional[1]) ?? 8787);

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

// Loopback binds keep the old trust model ("reaching this port at all means
// it's the host's own machine") intact, so /admin stays token-free there.
// Any wider bind puts /admin on the same listener as every player's join
// link (see BUGREPORT.md), so it needs its own secret in that case.
const isLoopback = bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
const adminToken = isLoopback ? undefined : randomBytes(24).toString("hex");

const app = createHttpApp(runtime, port, adminToken);
app.listen(port, bindHost, () => {
  // eslint-disable-next-line no-console
  console.log(`\nListening on ${bindHost}:${port}.`);
  if (adminToken) {
    // eslint-disable-next-line no-console
    console.log(`Bound beyond localhost — /admin requires header "x-admin-token: ${adminToken}"`);
  }
});
