import { describe, expect, it } from "vitest";
import { titleCase } from "../src/title.js";

/**
 * A flaky test: fails about 20% of the time. With QUEUE_FLAKE_SEED set the outcome is a pure
 * function of the seed (seeds 1-6 pass, 7-9 fail; see scenario.json), so tests can force it.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = process.env.QUEUE_FLAKE_SEED;
const draw = seed === undefined || seed === "" ? Math.random() : mulberry32(Number(seed))();

describe("flaky", () => {
  it("titles a headline under a flaky clock", () => {
    expect(titleCase("flaky clock")).toBe("Flaky Clock");
    expect(draw, `simulated flake (QUEUE_FLAKE_SEED=${seed ?? "unset"})`).toBeGreaterThanOrEqual(0.2);
  });
});
