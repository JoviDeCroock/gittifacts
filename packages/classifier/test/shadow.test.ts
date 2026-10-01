import type { Lane } from "@app/domain";
import { describe, expect, it } from "vitest";
import { type ShadowSample, sampleAgrees, shadowAgreement } from "../src/index.js";
import { policy } from "./helpers.js";

const agree: ShadowSample = { computedLane: 0, humanLane: null, decision: "approve" };
const disagree: ShadowSample = { computedLane: 0, humanLane: null, decision: "request-changes" };

function times(n: number, s: ShadowSample): ShadowSample[] {
  return Array.from({ length: n }, () => ({ ...s }));
}

const defaults = policy(); // agreementThreshold 0.95, minSamples 25

describe("sampleAgrees", () => {
  it.each([
    ["approve, no human lane", { computedLane: 0, humanLane: null, decision: "approve" }, true],
    ["approve, human says 0", { computedLane: 0, humanLane: 0, decision: "approve" }, true],
    ["approve, human says 1", { computedLane: 0, humanLane: 1, decision: "approve" }, false],
    ["approve, human says 2", { computedLane: 0, humanLane: 2, decision: "approve" }, false],
    ["request-changes", { computedLane: 0, humanLane: 0, decision: "request-changes" }, false],
    ["reject", { computedLane: 0, humanLane: null, decision: "reject" }, false],
    ["classifier said Lane 1", { computedLane: 1, humanLane: 0, decision: "approve" }, false],
  ] as const)("%s → %s", (_name, sample, expected) => {
    expect(sampleAgrees({ ...sample, computedLane: sample.computedLane as Lane })).toBe(expected);
  });
});

describe("shadowAgreement", () => {
  it("no samples: not eligible, needs minSamples agreeing samples", () => {
    expect(shadowAgreement([], defaults)).toEqual({
      samples: 0,
      agreed: 0,
      ratio: 0,
      eligibleToEnableLane0: false,
      needed: 25,
    });
  });

  it("only computedLane === 0 samples count", () => {
    const r = shadowAgreement(
      [
        ...times(3, agree),
        { computedLane: 1, humanLane: null, decision: "reject" },
        { computedLane: 2, humanLane: 0, decision: "approve" },
      ],
      defaults,
    );
    expect([r.samples, r.agreed, r.ratio]).toEqual([3, 3, 1]);
  });

  it("25 agreeing samples are eligible", () => {
    expect(shadowAgreement(times(25, agree), defaults)).toMatchObject({
      eligibleToEnableLane0: true,
      needed: 0,
      ratio: 1,
    });
  });

  it("24 of 25 (96%) clears a 95% threshold", () => {
    const r = shadowAgreement([...times(24, agree), disagree], defaults);
    expect(r).toMatchObject({ samples: 25, agreed: 24, eligibleToEnableLane0: true, needed: 0 });
  });

  it("23 of 25 (92%) needs 15 more agreeing samples (38/40 = 95%)", () => {
    const r = shadowAgreement([...times(23, agree), ...times(2, disagree)], defaults);
    expect(r).toMatchObject({
      samples: 25,
      agreed: 23,
      ratio: 0.92,
      eligibleToEnableLane0: false,
      needed: 15,
    });
  });

  it("a perfect ratio still needs minSamples", () => {
    expect(shadowAgreement(times(10, agree), defaults)).toMatchObject({
      eligibleToEnableLane0: false,
      needed: 15,
    });
  });

  it("threshold 1 with a disagreement on record can never be reached", () => {
    const strict = policy({ shadow: { agreementThreshold: 1, minSamples: 5 } });
    expect(shadowAgreement([...times(10, agree), disagree], strict)).toMatchObject({
      eligibleToEnableLane0: false,
      needed: null,
    });
    expect(shadowAgreement(times(3, agree), strict)).toMatchObject({ needed: 2 });
  });

  it("`needed` is exact: that many agreeing samples make it eligible, one fewer does not", () => {
    for (const threshold of [0.5, 0.8, 0.9, 0.95, 0.99]) {
      for (const minSamples of [1, 5, 25]) {
        const p = policy({ shadow: { agreementThreshold: threshold, minSamples } });
        for (let n = 0; n <= 30; n += 3) {
          for (let a = 0; a <= n; a += 2) {
            const samples = [...times(a, agree), ...times(n - a, disagree)];
            const r = shadowAgreement(samples, p);
            const needed = r.needed;
            expect(needed).not.toBeNull();
            if (needed === null) continue;
            const label = `t=${threshold} m=${minSamples} n=${n} a=${a} needed=${needed}`;
            expect(
              shadowAgreement([...samples, ...times(needed, agree)], p).eligibleToEnableLane0,
              label,
            ).toBe(true);
            if (needed > 0)
              expect(
                shadowAgreement([...samples, ...times(needed - 1, agree)], p).eligibleToEnableLane0,
                label,
              ).toBe(false);
          }
        }
      }
    }
  });
});
