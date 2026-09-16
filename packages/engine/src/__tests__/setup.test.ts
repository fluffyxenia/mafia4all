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
