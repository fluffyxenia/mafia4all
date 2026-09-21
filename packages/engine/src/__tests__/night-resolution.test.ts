import { describe, expect, it } from "vitest";
import type { NightActionRecord } from "@mafia/shared";
import { resolveNight } from "../resolution/night.js";
import { seat, testState } from "./test-helpers.js";

function action(record: Partial<NightActionRecord> & Pick<NightActionRecord, "actorId" | "actionType">) {
  return { day: 1, ...record } as NightActionRecord;
}

describe("resolveNight", () => {
  it("kills an unprotected mafia target", () => {
    const state = testState(
      [seat("mafia1", "mafia"), seat("victim", "town")],
      { nightActions: [action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "victim" })] },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "victim")!.alive).toBe(false);
    expect(next.players.find((p) => p.id === "victim")!.deathCause).toBe("mafia_kill");
  });

  it("mafia kill with no plurality target results in no kill", () => {
    const state = testState(
      [seat("mafia1", "mafia"), seat("mafia2", "mafia"), seat("a", "town"), seat("b", "town")],
      {
        nightActions: [
          action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "a" }),
          action({ actorId: "mafia2", actionType: "mafia_kill_proposal", targetId: "b" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.every((p) => p.alive)).toBe(true);
  });

  it("doctor protection blocks a mafia kill silently", () => {
    const state = testState(
      [seat("mafia1", "mafia"), seat("doc", "doctor"), seat("victim", "town")],
      {
        nightActions: [
          action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "victim" }),
          action({ actorId: "doc", actionType: "doctor_protect", targetId: "victim" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "victim")!.alive).toBe(true);
    const log = next.privateLog.find((l) => l.ownerId === "mafia1");
    expect(log?.result).toBe("nothing_happened");
  });

  it("doctor protection also blocks vigilante/JoAT friendly fire (confirmed scope)", () => {
    const state = testState(
      [seat("vig", "vigilante"), seat("doc", "doctor"), seat("victim", "town")],
      {
        nightActions: [
          action({ actorId: "vig", actionType: "vigilante_kill", targetId: "victim" }),
          action({ actorId: "doc", actionType: "doctor_protect", targetId: "victim" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "victim")!.alive).toBe(true);
  });

  it("multiple attackers on the same unprotected target: target dies once, only the resolution-order winner succeeds", () => {
    // Regression: this used to assert *both* attackers got a "success" log
    // entry, which was itself the bug — only one death is ever actually
    // recorded (whichever cause resolves first, mafia before SK per
    // resolveNight's build order), and the other attacker's kill never
    // registered at all despite its own private log falsely claiming it
    // had. Found live: this exact ambiguity decided a real game's outcome
    // when Mafia and a Vigilante both targeted the same Tanner the same
    // night — see killerLabel's doc comment.
    const state = testState(
      [seat("mafia1", "mafia"), seat("sk", "serial_killer"), seat("victim", "town")],
      {
        nightActions: [
          action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "victim" }),
          action({ actorId: "sk", actionType: "sk_kill", targetId: "victim" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.filter((p) => !p.alive)).toHaveLength(1);
    expect(next.privateLog.find((l) => l.ownerId === "mafia1")?.result).toBe("success");
    const skEntry = next.privateLog.find((l) => l.ownerId === "sk");
    expect(skEntry?.result).toBe("beaten_to_it");
    expect(skEntry?.text).toBe("Mafia got to victim before you could.");
  });

  it("sheriff investigation reports mafia / not-mafia", () => {
    const state = testState(
      [seat("sheriff", "sheriff"), seat("mafia1", "mafia"), seat("townie", "town")],
      {
        nightActions: [
          action({ actorId: "sheriff", actionType: "sheriff_investigate", targetId: "mafia1" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.privateLog.find((l) => l.ownerId === "sheriff")?.result).toBe("mafia");
  });

  it("deep diver investigation reports is-sk / not-sk", () => {
    const state = testState(
      [seat("dd", "deep_diver"), seat("sk", "serial_killer"), seat("townie", "town")],
      {
        nightActions: [
          action({ actorId: "dd", actionType: "deep_diver_investigate", targetId: "sk" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.privateLog.find((l) => l.ownerId === "dd" && l.targetId === "sk")?.result).toBe("is-sk");
  });

  it("Jack of All Trades investigate/protect/eliminate each consume their own one-shot charge", () => {
    const state = testState(
      [
        seat("joat", "jack_of_all_trades"),
        seat("mafia1", "mafia"),
        seat("victim", "town"),
      ],
      {
        nightActions: [
          action({ actorId: "joat", actionType: "joat_eliminate", targetId: "victim" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    const joat = next.players.find((p) => p.id === "joat")!;
    expect(joat.joatCharges).toEqual({ investigate: true, protect: true, eliminate: false });
    expect(next.players.find((p) => p.id === "victim")!.alive).toBe(false);
  });

  it("a Tanner killed by the SK boomerangs: that SK is eliminated too, side-win recorded", () => {
    const state = testState(
      [seat("sk", "serial_killer"), seat("tanner", "tanner"), seat("bystander", "town")],
      { nightActions: [action({ actorId: "sk", actionType: "sk_kill", targetId: "tanner" })] },
    );
    const { state: next } = resolveNight(state);
    const sk = next.players.find((p) => p.id === "sk")!;
    expect(sk.alive).toBe(false);
    expect(sk.deathCause).toBe("tanner_boomerang");
    expect(next.sideWins).toContainEqual(
      expect.objectContaining({ playerId: "tanner", role: "tanner", reason: "sk_kill" }),
    );
  });

  it("a Tanner killed by the Mafia side-wins and the whole Mafia faction is eliminated", () => {
    const state = testState(
      [
        seat("mafia1", "mafia"),
        seat("mafia2", "mafia"),
        seat("tanner", "tanner"),
        seat("bystander", "town"),
      ],
      {
        nightActions: [action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "tanner" })],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "mafia1")!.alive).toBe(false);
    expect(next.players.find((p) => p.id === "mafia2")!.alive).toBe(false);
    expect(next.sideWins).toContainEqual(
      expect.objectContaining({ playerId: "tanner", reason: "mafia_kill" }),
    );
  });

  it("Mafia and a Vigilante both targeting the Tanner the same night: Mafia's kill wins resolution order and boomerangs, the Vigilante's private log says it was beaten to it", () => {
    // Regression, found live: a real game had Mafia and a Vigilante both
    // independently target the Tanner the same night. Mafia's kill
    // resolves first (see resolveNight's build order) and boomerangs the
    // whole Mafia faction — a Vigilante kill on a Tanner would NOT have
    // boomeranged at all (see death-outcomes.ts's fall-through case), so
    // which cause "wins" here isn't cosmetic, it decides whether Mafia
    // survives the night. The Vigilante's own private log used to falsely
    // claim "success" for a kill that never actually registered.
    const state = testState(
      [
        seat("mafia1", "mafia"),
        seat("mafia2", "mafia"),
        seat("vig", "vigilante"),
        seat("tanner", "tanner"),
        seat("bystander", "town"),
      ],
      {
        nightActions: [
          action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "tanner" }),
          action({ actorId: "vig", actionType: "vigilante_kill", targetId: "tanner" }),
        ],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "tanner")!.deathCause).toBe("mafia_kill");
    expect(next.players.find((p) => p.id === "mafia1")!.alive).toBe(false);
    expect(next.players.find((p) => p.id === "mafia2")!.alive).toBe(false);
    expect(next.sideWins).toContainEqual(expect.objectContaining({ playerId: "tanner", reason: "mafia_kill" }));

    const vigEntry = next.privateLog.find((l) => l.ownerId === "vig");
    expect(vigEntry?.result).toBe("beaten_to_it");
    expect(vigEntry?.text).toBe("Mafia got to tanner before you could.");
  });

  it("Mafia-kills-Tanner-kills-Mafia still lets the game continue if another threat remains", () => {
    const state = testState(
      [
        seat("mafia1", "mafia"),
        seat("tanner", "tanner"),
        seat("sk", "serial_killer"),
        seat("bystander1", "town"),
        seat("bystander2", "town"),
      ],
      {
        nightActions: [action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "tanner" })],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "mafia1")!.alive).toBe(false);
    expect(next.winner).toBeUndefined();
    expect(next.phase).not.toBe("post_game");
  });

  it("a Tanner killed by the Vigilante just loses (confirmed fix, no side-win)", () => {
    const state = testState(
      [seat("vig", "vigilante"), seat("tanner", "tanner")],
      { nightActions: [action({ actorId: "vig", actionType: "vigilante_kill", targetId: "tanner" })] },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "tanner")!.alive).toBe(false);
    expect(next.sideWins).toHaveLength(0);
  });

  it("a Jester killed at night (not day vote) just loses, no side-win", () => {
    const state = testState(
      [seat("mafia1", "mafia"), seat("jester", "jester")],
      {
        nightActions: [action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "jester" })],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "jester")!.alive).toBe(false);
    expect(next.sideWins).toHaveLength(0);
  });

  it("heartbreak: killing one lover kills the surviving partner too", () => {
    const state = testState(
      [
        seat("mafia1", "mafia"),
        seat("loverA", "town", { loverPairId: "pair0" }),
        seat("loverB", "doctor", { loverPairId: "pair0" }),
      ],
      {
        nightActions: [action({ actorId: "mafia1", actionType: "mafia_kill_proposal", targetId: "loverA" })],
      },
    );
    const { state: next } = resolveNight(state);
    expect(next.players.find((p) => p.id === "loverA")!.alive).toBe(false);
    expect(next.players.find((p) => p.id === "loverB")!.alive).toBe(false);
    expect(next.players.find((p) => p.id === "loverB")!.deathCause).toBe("heartbreak");
  });
});
