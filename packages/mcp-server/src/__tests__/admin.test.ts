import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createAdminRouter, shuffled } from "../admin.js";
import { GameRuntime } from "../runtime.js";
import { freshTranscriptsDir } from "./test-harness.js";

// No existing test in this file ever supplies seat.ai, so mocking spawn for
// the whole module is safe — nothing else here touches a real child
// process. Captures the exact argv spawnAiSeat builds, so new flags can be
// asserted on without actually launching packages/ai-player's CLI.
const spawnCalls: string[][] = [];
vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    return child;
  },
}));

describe("shuffled", () => {
  it("returns a permutation — same elements, same length", () => {
    const input = ["p1", "p2", "p3", "p4", "p5"];
    const result = shuffled(input);
    expect(result).toHaveLength(input.length);
    expect([...result].sort()).toEqual([...input].sort());
  });

  it("doesn't mutate its input", () => {
    const input = ["p1", "p2", "p3"];
    shuffled(input);
    expect(input).toEqual(["p1", "p2", "p3"]);
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(["p1"])).toEqual(["p1"]);
  });

  it("actually varies the order across calls, not just a no-op copy", () => {
    // Statistical, not exact — a real shuffle occasionally reproduces the
    // original order by chance, but not on every one of many tries.
    const input = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const anyDifferent = Array.from({ length: 30 }, () => shuffled(input)).some(
      (result) => result.join(",") !== input.join(","),
    );
    expect(anyDifferent).toBe(true);
  });
});

async function withAdminServer(
  run: (baseUrl: string, runtime: GameRuntime) => Promise<void>,
): Promise<void> {
  const runtime = new GameRuntime(freshTranscriptsDir());
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(runtime, "http://localhost:0"));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://localhost:${port}`, runtime);
  } finally {
    server.close();
  }
}

describe("POST /admin/games — seat id shuffling", () => {
  // Regression: found live — a static launch config always requested the
  // same model under the same playerId (e.g. always "p3"), and a Mafia
  // blind-kill heuristic with no real signal to act on kept landing on that
  // id, repeatedly killing the same model night one across many games
  // regardless of role shuffling. Player-id assignment must not be stable
  // across games just because the request always lists seats the same way.
  it("doesn't always bind a given displayName to the same requested playerId", async () => {
    const seats = Array.from({ length: 8 }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Model-${i + 1}` }));
    const roleDistribution = { town: 8 };
    const assignedIdsForModel3 = new Set<string>();

    await withAdminServer(async (baseUrl) => {
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${baseUrl}/admin/games`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seats, roleDistribution }),
        });
        const body = (await res.json()) as { seats: { playerId: string; displayName: string }[] };
        const model3Seat = body.seats.find((s) => s.displayName === "Model-3")!;
        assignedIdsForModel3.add(model3Seat.playerId);
      }
    });

    expect(assignedIdsForModel3.size).toBeGreaterThan(1);
  });

  it("keeps each seat's displayName correctly bound to whichever id it was actually assigned", async () => {
    const seats = [
      { playerId: "p1", displayName: "Alice" },
      { playerId: "p2", displayName: "Bob" },
      { playerId: "p3", displayName: "Cara" },
    ];

    await withAdminServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seats, roleDistribution: { town: 3 } }),
      });
      const body = (await res.json()) as { gameId: string; seats: { playerId: string; displayName: string }[] };

      const stateRes = await fetch(`${baseUrl}/admin/games/${body.gameId}`);
      const state = (await stateRes.json()) as { players: { id: string; displayName: string }[] };

      for (const seat of body.seats) {
        const player = state.players.find((p) => p.id === seat.playerId);
        expect(player?.displayName).toBe(seat.displayName);
      }
    });
  });
});

describe("POST /admin/games — pinnedRole", () => {
  it("honors a pinned role after start_game, even though the seat's id was shuffled", async () => {
    // The two features interact: pinning is keyed to a seat's identity
    // (displayName/ai config in request order), not to the playerId label,
    // which is itself now randomized per game (see the shuffling tests
    // above). This confirms a pin survives that remapping end to end.
    const seats = [
      { playerId: "p1", displayName: "Alice", pinnedRole: "mafia" },
      { playerId: "p2", displayName: "Bob" },
      { playerId: "p3", displayName: "Cara" },
      { playerId: "p4", displayName: "Dan" },
    ];

    await withAdminServer(async (baseUrl, runtime) => {
      const createRes = await fetch(`${baseUrl}/admin/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seats, roleDistribution: { town: 2, mafia: 1, sheriff: 1 } }),
      });
      const created = (await createRes.json()) as { gameId: string; seats: { playerId: string; displayName: string }[] };

      const startRes = await fetch(`${baseUrl}/admin/games/${created.gameId}/start`, { method: "POST" });
      expect(startRes.ok).toBe(true);

      const state = runtime.getState(created.gameId);
      const aliceId = created.seats.find((s) => s.displayName === "Alice")!.playerId;
      const alice = state.players.find((p) => p.id === aliceId);
      expect(alice?.role).toBe("mafia");
    });
  });

  it("rejects (400) creating a game with an over-subscribed pin", async () => {
    const seats = [
      { playerId: "p1", displayName: "Alice", pinnedRole: "mafia" },
      { playerId: "p2", displayName: "Bob", pinnedRole: "mafia" },
      { playerId: "p3", displayName: "Cara" },
    ];

    await withAdminServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seats, roleDistribution: { town: 2, mafia: 1 } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/pinned to role 'mafia'/);
    });
  });
});

describe("POST /admin/games — AI seat spawn args", () => {
  it("forwards textToolCalling and alwaysIncludeToolCallExample as CLI flags for a llamacpp seat", async () => {
    spawnCalls.length = 0;
    const seats = [
      {
        playerId: "p1",
        displayName: "MiMo-VL 7B RL",
        ai: { backend: "llamacpp", baseUrl: "http://192.168.18.24:8080/v1", textToolCalling: true, alwaysIncludeToolCallExample: true },
      },
      { playerId: "p2", displayName: "Human" },
    ];

    await withAdminServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seats, roleDistribution: { town: 2 } }),
      });
      expect(res.ok).toBe(true);
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toContain("--text-tool-calling=true");
    expect(spawnCalls[0]).toContain("--always-tool-call-example=true");
  });

  it("omits both flags entirely when not requested, rather than sending an explicit false", async () => {
    spawnCalls.length = 0;
    const seats = [
      { playerId: "p1", displayName: "Plain llamacpp seat", ai: { backend: "llamacpp", baseUrl: "http://localhost:8080/v1" } },
      { playerId: "p2", displayName: "Human" },
    ];

    await withAdminServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seats, roleDistribution: { town: 2 } }),
      });
      expect(res.ok).toBe(true);
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.some((a) => a.startsWith("--text-tool-calling="))).toBe(false);
    expect(spawnCalls[0]!.some((a) => a.startsWith("--always-tool-call-example="))).toBe(false);
  });
});
