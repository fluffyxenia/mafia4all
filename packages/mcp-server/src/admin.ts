import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { SPECTATOR_PLAYER_ID } from "@mafia/engine";
import type { GameSetupConfig } from "@mafia/shared";
import type { GameRuntime } from "./runtime.js";

// Resolves to packages/ai-player/dist/cli.js as a sibling workspace package
// rather than a formal dependency — mcp-server only ever shells out to it as
// a subprocess (to run an AI seat locally), never imports it, so there's
// nothing here for a package.json dependency to actually give us.
const AI_PLAYER_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ai-player/dist/cli.js");

interface AiSeatRequest {
  backend?: "openrouter" | "llamacpp";
  model?: string;
  /** llamacpp only: base URL of a running llama-server instance, e.g. http://localhost:8080/v1. */
  baseUrl?: string;
  /** Path to append this seat's per-turn training records to (JSONL) — see AgentLoop's TurnRecord. */
  turnsLog?: string;
  /** Hard cap on generated tokens per request for this seat. See DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** llamacpp only: forces --enable-thinking=<value>. See LlamaCppAdapterOptions.enableThinking. */
  enableThinking?: boolean;
}

interface SeatRequest {
  playerId: string;
  displayName: string;
  color?: string;
  icon?: string;
  ai?: AiSeatRequest;
}

interface CreateGameRequest {
  seats: SeatRequest[];
  roleDistribution: GameSetupConfig["roleDistribution"];
  rngSeed?: number;
}

interface AdminGameEntry {
  aiProcesses: Map<string, ChildProcess>;
}

/**
 * Pre-game setup + light live status for the host console — deliberately
 * not a general game-editing API: once a game is started there is no
 * mid-game roster mutation here (kill/revive/force-phase etc.), only status
 * and a stop that just tears down this game's spawned AI processes. This
 * mirrors the "master session" the host actually asked for: a faster way to
 * assemble and launch a game, not a live game-master override console.
 */
export function createAdminRouter(runtime: GameRuntime, selfBaseUrl: string): express.Router {
  const router = express.Router();
  const adminGames = new Map<string, AdminGameEntry>();

  function spawnAiSeat(gameId: string, playerId: string, token: string, ai: AiSeatRequest): void {
    const joinUrl = `${selfBaseUrl}/mcp/${token}`;
    const args = [AI_PLAYER_CLI, joinUrl, `--backend=${ai.backend ?? "openrouter"}`];
    if (ai.model) args.push(`--model=${ai.model}`);
    if (ai.baseUrl) args.push(`--base-url=${ai.baseUrl}`);
    if (ai.turnsLog) args.push(`--turns-log=${ai.turnsLog}`);
    if (ai.maxTokens) args.push(`--max-tokens=${ai.maxTokens}`);
    if (ai.enableThinking !== undefined) args.push(`--enable-thinking=${ai.enableThinking}`);

    const child = spawn(process.execPath, args, { stdio: "inherit" });
    let entry = adminGames.get(gameId);
    if (!entry) {
      entry = { aiProcesses: new Map() };
      adminGames.set(gameId, entry);
    }
    entry.aiProcesses.set(playerId, child);
    child.on("exit", (code) => {
      // eslint-disable-next-line no-console
      console.log(`[admin] AI seat ${playerId} in game ${gameId} exited (code ${code})`);
      adminGames.get(gameId)?.aiProcesses.delete(playerId);
    });
  }

  router.post("/games", (req, res) => {
    const body = req.body as CreateGameRequest;
    if (!Array.isArray(body?.seats) || body.seats.length === 0) {
      res.status(400).json({ error: "seats must be a non-empty array" });
      return;
    }

    const config: GameSetupConfig = {
      seats: body.seats.map((s) => ({
        playerId: s.playerId,
        displayName: s.displayName,
        ...(s.color ? { color: s.color } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
      })),
      roleDistribution: body.roleDistribution,
      ...(body.rngSeed !== undefined ? { rngSeed: body.rngSeed } : {}),
    };

    let gameId: string;
    try {
      gameId = runtime.createGame(config);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const seats = body.seats.map((s) => {
      const token = runtime.issueToken(gameId, s.playerId);
      if (s.ai) spawnAiSeat(gameId, s.playerId, token, s.ai);
      return { playerId: s.playerId, displayName: s.displayName, token, isAi: Boolean(s.ai) };
    });

    res.json({ gameId, seats });
  });

  router.post("/games/:id/start", (req, res) => {
    const result = runtime.startGame(req.params.id!);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/games/:id", (req, res) => {
    let state;
    try {
      state = runtime.getState(req.params.id!);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const postGame = state.phase === "post_game";
    res.json({
      phase: state.phase,
      dayNumber: state.dayNumber,
      winner: state.winner,
      players: state.players.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        alive: p.alive,
        ...(postGame ? { role: p.role } : {}),
      })),
    });
  });

  router.post("/games/:id/spectate", (req, res) => {
    const gameId = req.params.id!;
    try {
      runtime.getState(gameId); // validates the game exists
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const token = runtime.issueToken(gameId, SPECTATOR_PLAYER_ID);
    res.json({ token });
  });

  router.post("/games/:id/stop", (req, res) => {
    const gameId = req.params.id!;
    const entry = adminGames.get(gameId);
    if (entry) {
      for (const child of entry.aiProcesses.values()) child.kill();
      adminGames.delete(gameId);
    }
    res.json({ ok: true });
  });

  return router;
}
