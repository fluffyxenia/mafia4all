/** One mulberry32 step: advances the state and produces a float in [0,1). */
function mulberry32Step(seed: number): { value: number; nextSeed: number } {
  let a = (seed >>> 0) | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextSeed: a };
}

/** Deterministic mulberry32 PRNG so games are replayable/testable given a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    const step = mulberry32Step(a);
    a = step.nextSeed;
    return step.value;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

/**
 * Stateful variant for randomness that needs to happen more than once
 * across a game (e.g. reshuffling the day-discussion turn order every
 * round) — a closure from `mulberry32` can't be persisted in `GameState`
 * between commands, so this threads the advanced seed back out explicitly
 * for the caller to store and pass into the next call.
 */
export function shuffleWithState<T>(items: readonly T[], seed: number): { result: T[]; nextSeed: number } {
  const result = items.slice();
  let currentSeed = seed;
  for (let i = result.length - 1; i > 0; i--) {
    const step = mulberry32Step(currentSeed);
    currentSeed = step.nextSeed;
    const j = Math.floor(step.value * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return { result, nextSeed: currentSeed };
}
