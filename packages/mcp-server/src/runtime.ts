import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { applyCommand, createGame as engineCreateGame, tryAdvancePhase } from "@mafia/engine";
import type { Command, CommandResult, GameSetupConfig, GameState, PlayerId } from "@mafia/shared";

interface TokenEntry {
  gameId: string;
  playerId: PlayerId;
}

const MAX_AUTO_ADVANCES = 1000;

// Every game lives only in the `games` map below; if this process dies or
// restarts mid-game, that state is gone. Mirror every mutation to disk so a
// missed recording can be re-run from a full transcript without waiting on
// live API calls again.
const TRANSCRIPTS_DIR = path.join(process.cwd(), "transcripts");

/**
 * Holds every active game in memory and is the single place commands flow
 * through: apply the command, then keep resolving phases
 * (night/day_discussion/day_vote) as long as their exit condition is
 * already met, since pacing is purely message-count/vote-driven with no
 * wall clock forcing a tick.
 */
export class GameRuntime {
  private games = new Map<string, GameState>();
  private tokens = new Map<string, TokenEntry>();
  private stateListeners = new Map<string, Set<() => void>>();

  /**
   * Subscribes to every successful state mutation for a game, regardless of
   * which player's session caused it. Each player's own MCP session is a
   * separate object with its own advertised tool list, but the game state
   * they all read from is shared — a phase change one player's action
   * triggers must still be visible to every other live session immediately,
   * not just the next time that other session happens to act or read its
   * view. Returns an unsubscribe function.
   */
  onStateChange(gameId: string, listener: () => void): () => void {
    let listeners = this.stateListeners.get(gameId);
    if (!listeners) {
      listeners = new Set();
      this.stateListeners.set(gameId, listeners);
    }
    listeners.add(listener);
    return () => listeners!.delete(listener);
  }

  createGame(config: GameSetupConfig, gameId: string = randomUUID()): string {
    if (this.games.has(gameId)) throw new Error(`game ${gameId} already exists`);
    const state = engineCreateGame(config);
    this.games.set(gameId, state);
    this.persist(gameId, state);
    return gameId;
  }

  /**
   * Writes the full authoritative state (every role, every private log,
   * every chat message) to transcripts/<gameId>.json. Best-effort — a disk
   * hiccup here must never take down a live game, so failures are logged
   * and swallowed rather than thrown.
   */
  private persist(gameId: string, state: GameState): void {
    try {
      mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
      writeFileSync(path.join(TRANSCRIPTS_DIR, `${gameId}.json`), JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`[runtime] failed to persist transcript for game ${gameId}: ${String(err)}`);
    }
  }

  startGame(gameId: string): CommandResult {
    return this.applyPlayerCommand(gameId, { type: "start_game" });
  }

  issueToken(gameId: string, playerId: PlayerId, token: string = randomUUID()): string {
    if (!this.games.has(gameId)) throw new Error(`unknown game: ${gameId}`);
    this.tokens.set(token, { gameId, playerId });
    return token;
  }

  resolveToken(token: string): TokenEntry | undefined {
    return this.tokens.get(token);
  }

  getState(gameId: string): GameState {
    const state = this.games.get(gameId);
    if (!state) throw new Error(`unknown game: ${gameId}`);
    return state;
  }

  applyPlayerCommand(gameId: string, command: Command): CommandResult {
    const state = this.getState(gameId);
    const result = applyCommand(state, command);
    if (!result.ok) return result;

    let next = result.state;
    const events = [...result.events];
    for (let i = 0; i < MAX_AUTO_ADVANCES; i++) {
      const advanced = tryAdvancePhase(next);
      if (!advanced) break;
      next = advanced.state;
      events.push(...advanced.events);
    }

    this.games.set(gameId, next);
    this.persist(gameId, next);
    for (const listener of this.stateListeners.get(gameId) ?? []) listener();
    return { ok: true, state: next, events };
  }
}
