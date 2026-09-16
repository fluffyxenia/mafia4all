import { describe, expect, it } from "vitest";
import type { Vote } from "@mafia/shared";
import { resolveDayVote } from "../resolution/day-vote.js";
import { seat, testState } from "./test-helpers.js";

function vote(voterId: string, target: Vote["target"]): Vote {
  return { voterId, target, day: 1 };
}

describe("resolveDayVote", () => {
  it("eliminates a player who wins plurality and moves to night with dayNumber+1", () => {
    // A second mafia survives the elimination so this doesn't also trigger
    // a Town win, which is covered separately below.
    const state = testState(
      [seat("a", "town"), seat("b", "mafia"), seat("c", "town"), seat("d", "mafia")],
      { phase: "day_vote", votes: [vote("a", "b"), vote("c", "b")] },
    );
    const { state: next } = resolveDayVote(state);
    expect(next.players.find((p) => p.id === "b")!.alive).toBe(false);
    expect(next.phase).toBe("night");
    expect(next.dayNumber).toBe(2);
    expect(next.drawOutCounter).toBe(0);
    // Regression: the mafia channel's turn queue used to only ever get
    // seeded at game start — every later transition into a new night left
    // it stale/empty, silently locking every mafia member out of their own
    // team chat for the rest of the game.
    expect(next.channelTurnQueues.mafia).toEqual(["d"]);
  });

  it("a tie results in no elimination and increments the draw-out counter", () => {
    const tied = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_vote",
      votes: [vote("a", "b"), vote("b", "a")],
    });
    const { state: next } = resolveDayVote(tied);
    expect(next.players.every((p) => p.alive)).toBe(true);
    expect(next.drawOutCounter).toBe(1);
    expect(next.phase).toBe("night");
  });

  it("abstain plurality: no elimination, draw-out increments", () => {
    const state = testState([seat("a", "town"), seat("b", "town"), seat("c", "town")], {
      phase: "day_vote",
      votes: [vote("a", "abstain"), vote("b", "abstain"), vote("c", "a")],
    });
    const { state: next } = resolveDayVote(state);
    expect(next.players.every((p) => p.alive)).toBe(true);
    expect(next.drawOutCounter).toBe(1);
  });

  it("three consecutive no-elimination days end the game with everyone losing", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_vote",
      drawOutCounter: 2,
      votes: [vote("a", "abstain"), vote("b", "abstain")],
    });
    const { state: next } = resolveDayVote(state);
    // A win/draw-out transitions straight into the post-game debrief, not
    // the truly-terminal post_game — see win-conditions.ts's finalizeWinner
    // and incrementDrawOut, and debrief.test.ts for the debrief itself.
    expect(next.phase).toBe("debrief");
    expect(next.winner).toEqual({ result: "draw_out", winningPlayerIds: [] });
    expect(new Set(next.debriefQueue)).toEqual(new Set(["a", "b"]));
  });

  it("request_more_messages wins: resets to day_discussion, usable once per day", () => {
    const state = testState([seat("a", "town"), seat("b", "town")], {
      phase: "day_vote",
      votes: [vote("a", "request_more_messages"), vote("b", "request_more_messages")],
    });
    const { state: next } = resolveDayVote(state);
    expect(next.phase).toBe("day_discussion");
    expect(next.dayNumber).toBe(1);
    expect(next.requestMoreMessagesUsedToday).toBe(true);
  });

  it("request_more_messages: never lets the last discussion speaker open the reshuffled cycle too", () => {
    // Regression: this reshuffle used to omit avoidFirst entirely, so
    // whoever spoke last before the vote (with only two eligible players,
    // a coin flip; here forced via lastTownSpeakerId) could immediately
    // speak first again once discussion resumed, with zero phase gap.
    for (let seed = 0; seed < 50; seed++) {
      const state = testState([seat("a", "town"), seat("b", "town")], {
        phase: "day_vote",
        rngState: seed,
        lastTownSpeakerId: "b",
        votes: [vote("a", "request_more_messages"), vote("b", "request_more_messages")],
      });
      const { state: next } = resolveDayVote(state);
      expect(next.dayTurnQueue[0]).toBe("a");
    }
  });

  it("eliminating the last hostile threat ends the game as a Town win mid-resolution", () => {
    const state = testState([seat("a", "town"), seat("b", "mafia")], {
      phase: "day_vote",
      votes: [vote("a", "b"), vote("b", "b")],
    });
    const { state: next } = resolveDayVote(state);
    expect(next.phase).toBe("debrief");
    expect(next.winner?.result).toBe("town");
  });

  it("voting out the Jester enters the revenge sub-phase instead of night", () => {
    const state = testState(
      [seat("a", "town"), seat("b", "town"), seat("jester", "jester")],
      {
        phase: "day_vote",
        votes: [vote("a", "jester"), vote("b", "jester")],
      },
    );
    const { state: next } = resolveDayVote(state);
    expect(next.phase).toBe("jester_revenge_subphase");
    expect(next.pendingJesterRevenge?.jesterId).toBe("jester");
    expect(next.pendingJesterRevenge?.eligibleTargets.sort()).toEqual(["a", "b"]);
    expect(next.sideWins).toContainEqual(
      expect.objectContaining({ playerId: "jester", role: "jester", reason: "day_vote" }),
    );
  });

  it("voting out the Tanner ends the game immediately with Tanner as sole winner", () => {
    const state = testState(
      [seat("a", "town"), seat("b", "town"), seat("tanner", "tanner")],
      {
        phase: "day_vote",
        votes: [vote("a", "tanner"), vote("b", "tanner")],
      },
    );
    const { state: next } = resolveDayVote(state);
    // Straight into the post-game debrief, not the truly-terminal
    // post_game — see apply-deaths.ts's immediateWinner handling and
    // death-reveal.test.ts's dedicated regression test for this path.
    expect(next.phase).toBe("debrief");
    expect(next.winner).toEqual({ result: "tanner", winningPlayerIds: ["tanner"] });
  });
});
