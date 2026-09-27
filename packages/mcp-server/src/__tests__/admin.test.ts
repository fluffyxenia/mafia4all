import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { createAdminRouter, shuffled } from "../admin.js";
import { GameRuntime } from "../runtime.js";

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
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const runtime = new GameRuntime();
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(runtime, "http://localhost:0"));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://localhost:${port}`);
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
