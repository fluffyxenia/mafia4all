import { describe, expect, it } from "vitest";
import type { NightActionRecord } from "@mafia/shared";
import { tryAdvancePhase } from "../advance.js";
import { seat, testState } from "./test-helpers.js";

function action(record: Partial<NightActionRecord> & Pick<NightActionRecord, "actorId" | "actionType">) {
  return { day: 1, ...record } as NightActionRecord;
}

describe("tryAdvancePhase — night readiness", () => {
  // Regression, found live mid-game: a Jack of All Trades with every
  // one-shot charge already spent has no tool left to call at all —
  // tool-availability.ts stops offering night_action *and* pass once
  // allowedActionTypes is empty — yet the old nightReady() still
  // unconditionally required a night-action record from any living JOAT,
  // with no equivalent to the mafia/deep_diver "ran out of channel budget"
  // exception. That deadlocked night forever with no way out.
  it("doesn't block night from resolving on a JOAT with every charge already spent", () => {
    const state = testState(
      [
        seat("joat", "jack_of_all_trades", { joatCharges: { investigate: false, protect: false, eliminate: false } }),
        seat("victim", "town"),
      ],
      { nightActions: [] },
    );
    expect(tryAdvancePhase(state)).not.toBeNull();
  });

  it("still blocks night while a JOAT has an unspent charge and hasn't acted", () => {
    const state = testState(
      [seat("joat", "jack_of_all_trades"), seat("victim", "town")],
      { nightActions: [] },
    );
    expect(tryAdvancePhase(state)).toBeNull();
  });

  it("a JOAT with charges remaining who explicitly passed also unblocks night", () => {
    const state = testState(
      [seat("joat", "jack_of_all_trades"), seat("victim", "town")],
      { nightActions: [action({ actorId: "joat", actionType: "pass" })] },
    );
    expect(tryAdvancePhase(state)).not.toBeNull();
  });
});
