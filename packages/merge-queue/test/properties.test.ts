/**
 * Property-based tests of the pure core over random workloads (§8): random affected sets (some
 * unknown), bad changes, textual and semantic conflicts, flakes, stacks, plan groups, priorities,
 * dequeues, freezes and automatic reverts — with IO completing in random order.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { queueConfig } from "../src/index.js";
import { affected, World } from "./harness.js";
import { checkRun, FILES, opArb, run, specArb } from "./prop-helpers.js";

describe("merge-queue core properties", () => {
  it("main only advances to tested, green trees; nothing lost or duplicated; stacks, groups, lanes, freezes hold", () => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 1, maxLength: 12 }),
        fc.array(opArb, { maxLength: 80 }),
        fc.array(fc.nat(50), { maxLength: 200 }),
        fc.constantFrom(0, 0.1, 0.3),
        (specs, ops, picks, flakeRate) => {
          const { w } = run(specs, ops, picks, { flakeRate });
          checkRun(w);
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 300) },
    );
  });

  it("unknown affected sets never run in parallel with another track", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant<"unknown">("unknown"),
            fc.subarray(FILES, { minLength: 1, maxLength: 1 }),
          ),
          { minLength: 2, maxLength: 10 },
        ),
        fc.array(fc.nat(30), { maxLength: 100 }),
        (kinds, picks) => {
          const w = new World({ checkInvariants: true });
          kinds.forEach((k, i) => {
            const a =
              k === "unknown"
                ? { ...affected({ files: ["?"] }), complete: false }
                : affected({ files: k });
            w.enqueue({ id: `u${i}`, affected: a });
            // checkStateInvariants (run after every step) throws "parallel.unknown" on a violation.
            const tracks = Object.values(w.state.tracks);
            const unknownTrack = tracks.find((t) =>
              t.chain.some((b) =>
                w.state.batches[b]?.units.some((u) =>
                  u.changeIds.some((id) => w.state.entries[id]?.affected?.complete === false),
                ),
              ),
            );
            if (unknownTrack !== undefined) expect(tracks.length).toBe(1);
          });
          let k = 0;
          w.drain(10_000, (n) => picks[k++ % Math.max(1, picks.length)] ?? n);
          expect(w.violations.join("; ")).toBe("");
          expect(new Set(w.merged).size).toBe(kinds.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("aging bounds the wait of a low-priority entry under a flood of security fixes", () => {
    const agingStepMs = 10 * 60_000;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 2, max: 8 }),
        (perTick, ciTicks) => {
          // One track, no speculation: the scheduling order alone decides who goes next.
          const config = queueConfig({
            maxTracks: 1,
            maxSpeculationDepth: 1,
            maxBatchSize: 1,
            agingStepMs,
            features: { conflictGraph: false },
          });
          const w = new World({ config, checkInvariants: false });
          w.enqueue({ id: "slow", affected: affected({ files: ["x"] }), lane: 2, session: "s" });
          let n = 0;
          let enteredAt: number | null = null;
          for (let minute = 0; minute < 6 * 60 && enteredAt === null; minute++) {
            for (let j = 0; j < perTick; j++)
              w.enqueue({
                id: `sec${n++}`,
                affected: affected({ files: ["x"] }),
                priority: "security",
                session: `f${n % 3}`,
              });
            // CI finishes a run every `ciTicks` minutes.
            if (minute % ciTicks === 0) while (w.outstanding > 0) w.complete(0);
            w.tick(60_000);
            if (w.state.entries.slow?.firstBatchAt !== null)
              enteredAt = w.state.entries.slow?.firstBatchAt ?? null;
          }
          expect(enteredAt).not.toBeNull();
          // rank 4 → 1 after 3 aging steps; then it is the oldest entry of its class.
          expect(enteredAt ?? Infinity).toBeLessThanOrEqual(
            3 * agingStepMs + (ciTicks + 2) * 60_000 * 2,
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it("lanes never decrease even when the resolver reports a lower lane", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(30), { maxLength: 60 }), (picks) => {
        const w = new World({ resolverLowersLane: true });
        w.enqueue({ id: "a", affected: affected({ files: ["s.ts"] }), lane: 1 });
        w.enqueue({
          id: "b",
          affected: affected({ files: ["s.ts"] }),
          lane: 2,
          textualWith: ["a"],
        });
        w.enqueue({
          id: "c",
          affected: affected({ files: ["s.ts"] }),
          lane: 1,
          semanticWith: ["a"],
        });
        let k = 0;
        w.drain(5_000, (n) => picks[k++ % Math.max(1, picks.length)] ?? n);
        expect(w.violations).toEqual([]);
        expect(w.state.entries.b?.lane).toBe(2);
        expect(w.state.entries.c?.lane).toBeGreaterThanOrEqual(1);
        expect(
          w.commands.some((c) => c.type === "Telemetry" && c.kind === "lane-downgrade-ignored"),
        ).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
