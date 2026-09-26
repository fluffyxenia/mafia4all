import { describe, expect, it } from "vitest";
import { estimateDurationMs, LIVE_DURATION_CAP_MS } from "../tts.js";

describe("estimateDurationMs", () => {
  it("scales with word count between the floor and the cap", () => {
    const short = estimateDurationMs("Locked in.");
    const long = estimateDurationMs(Array(20).fill("word").join(" "));
    expect(long).toBeGreaterThan(short);
  });

  it("floors very short messages so they still get a visible beat", () => {
    expect(estimateDurationMs("Hi")).toBeGreaterThanOrEqual(900);
  });

  it("defaults to live play's 12s cap regardless of length", () => {
    const veryLong = Array(200).fill("word").join(" ");
    expect(estimateDurationMs(veryLong)).toBe(LIVE_DURATION_CAP_MS);
  });

  it("honors a custom cap (used by replay for a more generous ceiling)", () => {
    // Regression: found live — replaying a real game, most messages
    // (median ~54 words, well past live's 12s-worth of reading time)
    // clamped to the exact same 12s hold, reading like a fixed timer
    // instead of pacing tied to actual message length.
    const veryLong = Array(200).fill("word").join(" ");
    expect(estimateDurationMs(veryLong, 60_000)).toBe(60_000);

    const medium = Array(54).fill("word").join(" "); // this game's real median length
    expect(estimateDurationMs(medium, 12_000)).toBe(12_000); // clamped under live's cap
    expect(estimateDurationMs(medium, 60_000)).toBeCloseTo((54 / 2.5) * 1000, 0); // full length under replay's cap
  });
});
