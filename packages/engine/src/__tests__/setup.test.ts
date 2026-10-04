import { describe, expect, it } from "vitest";
import type { GameSetupConfig } from "@mafia/shared";
import { assignRolesAndStart, createGame } from "../setup.js";

function config(overrides: Partial<GameSetupConfig> = {}): GameSetupConfig {
  return {
    seats: [
      { playerId: "p1", displayName: "Alice" },
      { playerId: "p2", displayName: "Bob" },
      { playerId: "p3", displayName: "Cara" },
      { playerId: "p4", displayName: "Dan" },
    ],
    roleDistribution: { town: 2, mafia: 1, sheriff: 1 },
    rngSeed: 42,
    ...overrides,
  };
}

describe("createGame / assignRolesAndStart", () => {
  it("rejects a role distribution that doesn't match the seat count", () => {
    expect(() => createGame(config({ roleDistribution: { town: 1 } }))).toThrow();
  });

  it("assigns exactly the configured roles and transitions to night 1", () => {
    const state = assignRolesAndStart(createGame(config()));
    expect(state.phase).toBe("night");
    expect(state.dayNumber).toBe(1);
    const roles = state.players.map((p) => p.role).sort();
    expect(roles).toEqual(["mafia", "sheriff", "town", "town"].sort());
  });

  it("gives the Jack of All Trades all three one-shot charges", () => {
    const state = assignRolesAndStart(
      createGame(config({ roleDistribution: { jack_of_all_trades: 1, town: 3 } })),
    );
    const joat = state.players.find((p) => p.role === "jack_of_all_trades")!;
    expect(joat.joatCharges).toEqual({ investigate: true, protect: true, eliminate: true });
  });

  it("tags lover pairs regardless of their assigned base role", () => {
    const state = assignRolesAndStart(
      createGame(config({ loverPairs: [["p1", "p2"]] })),
    );
    const p1 = state.players.find((p) => p.id === "p1")!;
    const p2 = state.players.find((p) => p.id === "p2")!;
    expect(p1.loverPairId).toBeDefined();
    expect(p1.loverPairId).toBe(p2.loverPairId);
  });

  it("is deterministic for a given rngSeed", () => {
    const a = assignRolesAndStart(createGame(config({ rngSeed: 7 })));
    const b = assignRolesAndStart(createGame(config({ rngSeed: 7 })));
    expect(a.players.map((p) => p.role)).toEqual(b.players.map((p) => p.role));
  });
});

describe("pinnedRole", () => {
  function pinnedConfig(overrides: Partial<GameSetupConfig> = {}): GameSetupConfig {
    return config({
      seats: [
        { playerId: "p1", displayName: "Alice", pinnedRole: "mafia" },
        { playerId: "p2", displayName: "Bob" },
        { playerId: "p3", displayName: "Cara" },
        { playerId: "p4", displayName: "Dan" },
      ],
      ...overrides,
    });
  }

  it("honors a pinned role exactly, regardless of rngSeed", () => {
    for (const rngSeed of [1, 2, 3, 4, 5]) {
      const state = assignRolesAndStart(createGame(pinnedConfig({ rngSeed })));
      expect(state.players.find((p) => p.id === "p1")!.role).toBe("mafia");
    }
  });

  it("still assigns exactly the configured role counts overall", () => {
    const state = assignRolesAndStart(createGame(pinnedConfig()));
    const roles = state.players.map((p) => p.role).sort();
    expect(roles).toEqual(["mafia", "sheriff", "town", "town"].sort());
  });

  it("varies the unpinned seats' roles across different seeds, not just a static leftover order", () => {
    const rolesFor = (rngSeed: number) =>
      assignRolesAndStart(createGame(pinnedConfig({ rngSeed })))
        .players.filter((p) => p.id !== "p1")
        .map((p) => p.role)
        .join(",");
    const results = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(rolesFor));
    expect(results.size).toBeGreaterThan(1);
  });

  it("rejects pinning more seats to a role than the distribution allocates for it, at createGame time", () => {
    // Regression target: a host should see this immediately when creating
    // the game, not only once they click Start.
    expect(() =>
      createGame(
        pinnedConfig({
          roleDistribution: { town: 2, mafia: 1, sheriff: 1 },
          seats: [
            { playerId: "p1", displayName: "Alice", pinnedRole: "mafia" },
            { playerId: "p2", displayName: "Bob", pinnedRole: "mafia" },
            { playerId: "p3", displayName: "Cara" },
            { playerId: "p4", displayName: "Dan" },
          ],
        }),
      ),
    ).toThrow(/pinned to role 'mafia'/);
  });

  it("assigns joatCharges to a pinned Jack of All Trades seat like any other", () => {
    const state = assignRolesAndStart(
      createGame(
        config({
          roleDistribution: { jack_of_all_trades: 1, town: 3 },
          seats: [
            { playerId: "p1", displayName: "Alice", pinnedRole: "jack_of_all_trades" },
            { playerId: "p2", displayName: "Bob" },
            { playerId: "p3", displayName: "Cara" },
            { playerId: "p4", displayName: "Dan" },
          ],
        }),
      ),
    );
    const p1 = state.players.find((p) => p.id === "p1")!;
    expect(p1.role).toBe("jack_of_all_trades");
    expect(p1.joatCharges).toEqual({ investigate: true, protect: true, eliminate: true });
  });
});
