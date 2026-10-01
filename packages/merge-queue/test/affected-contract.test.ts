/**
 * The core keeps a structural copy of `@app/affected`'s AffectedSet (no package dependency yet).
 * These tests prove the copy is the same contract: identical inferred types, identical parsing,
 * and identical conflict and component semantics over random sets (incl. sentinels).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ALL_TESTS as THEIR_ALL_TESTS,
  CONFIG_SENTINEL as THEIR_CONFIG,
  AffectedSet as TheirAffectedSet,
  conflictBetween,
  conflictComponents,
} from "../../affected/src/index.js";
import { ALL_TESTS, AffectedSet, CONFIG_SENTINEL, components, conflicts } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameType: Equals<z.infer<typeof AffectedSet>, z.infer<typeof TheirAffectedSet>> = true;

const setArb = fc.record({
  files: fc.subarray(["a.ts", "b.ts", "c.ts", "d.ts"]),
  modules: fc.subarray(["m1", "m2", "m3", CONFIG_SENTINEL]),
  testTargets: fc.subarray(["t1", "t2", "t3", ALL_TESTS]),
  publicApi: fc.boolean(),
  deploysTo: fc.subarray(["w1", "w2"]),
  complete: fc.boolean(),
  analyzers: fc.boolean().map((b) => (b ? [{ name: "ts", version: "1", complete: true }] : [])),
});

describe("AffectedSet contract matches @app/affected", () => {
  it("has the same type and sentinels", () => {
    expect(sameType).toBe(true);
    expect(ALL_TESTS).toBe(THEIR_ALL_TESTS);
    expect(CONFIG_SENTINEL).toBe(THEIR_CONFIG);
  });

  it("parses identically", () => {
    fc.assert(
      fc.property(setArb, (s) => {
        expect(AffectedSet.parse(s)).toEqual(TheirAffectedSet.parse(s));
      }),
    );
  });

  it("conflicts exactly when conflictBetween says so", () => {
    fc.assert(
      fc.property(setArb, setArb, (a, b) => {
        expect(conflicts(a, b)).toBe(conflictBetween(a, b) !== null);
      }),
      { numRuns: 2000 },
    );
  });

  it("partitions into the same connected components as conflictComponents", () => {
    fc.assert(
      fc.property(fc.array(setArb, { maxLength: 9 }), (sets) => {
        const ids = sets.map((_, i) => `c${i}`);
        const mine = components(ids, (id) => sets[Number(id.slice(1))] ?? null);
        const theirs = conflictComponents(new Map(ids.map((id, i) => [id, sets[i] ?? TheirAffectedSet.parse({ files: [], modules: [], testTargets: [], publicApi: false, deploysTo: [], complete: true, analyzers: [] })])));
        const norm = (groups: string[][]) => groups.map((g) => [...g].sort().join(",")).sort();
        expect(norm(mine)).toEqual(norm(theirs));
      }),
      { numRuns: 1000 },
    );
  });
});
