/**
 * Property-based tests of the pure core over random workloads (§8): random affected sets (some
 * unknown), bad changes, textual and semantic conflicts, flakes, stacks, plan groups, priorities,
 * dequeues, freezes and automatic reverts — with IO completing in random order.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALL_TESTS, type AffectedSet, CONFIG_SENTINEL, queueConfig, TERMINAL_STATES } from "../src/index.js";
import { affected, type TestChange, World } from "./harness.js";

const FILES = ["f0", "f1", "f2", "f3", "f4", "f5"];
const TESTS = ["t0", "t1", "t2", "t3"];

const affectedArb: fc.Arbitrary<AffectedSet | null | "incomplete"> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc
      .record({
        files: fc.subarray(FILES, { minLength: 1, maxLength: 2 }),
        tests: fc.subarray(TESTS, { minLength: 0, maxLength: 2 }),
      })
      .map((k) => affected(k)),
  },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant("incomplete" as const) },
  // Config change (conflicts with everything) and "all tests" (meets any non-empty test set).
  { weight: 1, arbitrary: fc.subarray(FILES, { minLength: 1, maxLength: 1 }).map((files) => affected({ files, modules: [CONFIG_SENTINEL], tests: [ALL_TESTS] })) },
  { weight: 1, arbitrary: fc.subarray(FILES, { minLength: 1, maxLength: 1 }).map((files) => affected({ files, tests: [ALL_TESTS] })) },
);

const specArb = fc.record({
  affected: affectedArb,
  bad: fc.nat(9).map((x) => x === 0),
  textual: fc.nat(7).map((x) => x === 0),
  semantic: fc.nat(11).map((x) => x === 0),
  partner: fc.nat(20),
  dep: fc.nat(6).map((x) => x === 0),
  atomic: fc.boolean(),
  group: fc.nat(9).map((x) => x === 0),
  priority: fc.constantFrom("normal", "normal", "normal", "normal", "security", "incident"),
  lane: fc.constantFrom(0, 0, 1, 2),
  session: fc.constantFrom("a", "b", "c"),
});
type Spec = typeof specArb extends fc.Arbitrary<infer T> ? T : never;

type Op =
  | { k: "enqueue" }
  | { k: "complete"; i: number }
  | { k: "tick"; ms: number }
  | { k: "dequeue"; i: number }
  | { k: "freeze" }
  | { k: "thaw" }
  | { k: "postMergeFail" }
  | { k: "revert" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.constant<Op>({ k: "enqueue" }) },
  { weight: 14, arbitrary: fc.nat(1000).map<Op>((i) => ({ k: "complete", i })) },
  { weight: 2, arbitrary: fc.integer({ min: 1000, max: 20 * 60_000 }).map<Op>((ms) => ({ k: "tick", ms })) },
  { weight: 1, arbitrary: fc.nat(100).map<Op>((i) => ({ k: "dequeue", i })) },
  { weight: 1, arbitrary: fc.constant<Op>({ k: "freeze" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ k: "thaw" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ k: "postMergeFail" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ k: "revert" }) },
);

function toChanges(specs: Spec[]): TestChange[] {
  const groupSize = specs.filter((s) => s.group).length;
  return specs.map((s, i): TestChange => {
    const id = `c${i}`;
    const partner = i > 0 ? `c${s.partner % i}` : null;
    const a = s.affected === "incomplete" ? { ...affected({ files: ["fz"] }), complete: false } : s.affected;
    const inGroup = s.group && groupSize > 1;
    return {
      id,
      affected: a,
      bad: s.bad,
      textualWith: s.textual && partner !== null ? [partner] : [],
      semanticWith: s.semantic && partner !== null ? [partner] : [],
      dependsOn: s.dep && partner !== null && !inGroup && !specs[s.partner % i]?.group ? [partner] : [],
      landMode: s.atomic ? "atomic" : "incremental",
      plangroup: inGroup ? "G" : null,
      landTogether: inGroup,
      groupSize: inGroup ? groupSize : null,
      priority: s.priority as TestChange["priority"],
      lane: s.lane as 0 | 1 | 2,
      session: s.session,
    };
  });
}

function run(specs: Spec[], ops: Op[], picks: number[], opts: { flakeRate: number; config?: ReturnType<typeof queueConfig> }) {
  const changes = toChanges(specs);
  const w = new World({ flakeRate: opts.flakeRate, flakeRepeat: 0.3, resolverSuccess: 0.7, ...(opts.config ? { config: opts.config } : {}) });
  let next = 0;
  let reverts = 0;
  const human = { principalId: "human-1", kind: "human" as const, signature: "sig" };
  for (const op of ops) {
    switch (op.k) {
      case "enqueue": {
        const c = changes[next];
        if (c !== undefined) {
          w.enqueue(c);
          next++;
        }
        break;
      }
      case "complete":
        w.complete(op.i);
        break;
      case "tick":
        w.tick(op.ms);
        break;
      case "dequeue": {
        if (next === 0) break;
        w.send({ type: "Dequeued", changeId: `c${op.i % next}`, by: "agent-a" });
        break;
      }
      case "freeze":
        w.send({ type: "Freeze", signer: human, reason: "manual freeze" });
        break;
      case "thaw":
        w.send({ type: "Thaw", signer: human, reason: "manual thaw" });
        break;
      case "postMergeFail":
        w.send({ type: "PostMergeCheckFailed", sha: w.mainSha, checks: ["smoke"] });
        break;
      case "revert": {
        const target = w.merged[w.merged.length - 1];
        if (target === undefined) break;
        const orig = w.changes.get(target);
        w.enqueue({ id: `r${reverts++}`, affected: orig?.affected ?? null, priority: "revert", revertOf: target, automaticRevert: true, lane: 0 });
        break;
      }
    }
  }
  for (const c of changes.slice(next)) w.enqueue(c);
  let k = 0;
  const pick = (n: number): number => picks[k++ % Math.max(1, picks.length)] ?? n;
  for (let round = 0; round < 3; round++) {
    w.send({ type: "Thaw", signer: human, reason: "end of test" });
    w.drain(30_000, pick);
  }
  return { w, changes };
}

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
          // §1: main never red, only tested trees, frozen lands only reverts, lanes never drop.
          expect(w.violations.join("; ")).toBe("");
          // No entry lost: every enqueued change ends merged, ejected or dequeued.
          for (const id of w.enqueued) {
            const e = w.state.entries[id];
            expect(e, `entry ${id}`).toBeDefined();
            expect(TERMINAL_STATES.has(e?.state ?? "waiting"), `${id} is ${e?.state} (hold ${e?.hold})`).toBe(true);
          }
          // ...and none duplicated: merged at most once, never both merged and ejected.
          expect(new Set(w.merged).size).toBe(w.merged.length);
          for (const id of w.merged) expect(w.state.entries[id]?.state).toBe("merged");
          // Stacks never reordered: a dependency lands before (or in the same CAS ahead of) its dependent.
          const order = new Map(w.merged.map((id, i) => [id, i]));
          for (const [id, c] of w.changes)
            for (const d of c.dependsOn ?? []) {
              if (!order.has(id)) continue;
              expect(order.has(d), `${id} merged without its dependency ${d}`).toBe(true);
              expect(order.get(d) ?? Infinity).toBeLessThan(order.get(id) ?? -1);
            }
          // Plan groups all-or-nothing, in one CAS.
          const group = [...w.changes.values()].filter((c) => c.landTogether);
          const landedMembers = group.filter((c) => order.has(c.id));
          if (landedMembers.length > 0) {
            expect(landedMembers.length).toBe(group.length);
            const cas = w.casLog.filter((l) => l.cas.entries.some((e) => group.some((g) => g.id === e.changeId)));
            expect(cas.length).toBe(1);
          }
          // Refs are garbage-collected.
          expect([...w.refs]).toEqual([]);
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 300) },
    );
  });

  it("unknown affected sets never run in parallel with another track", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant<"unknown">("unknown"), fc.subarray(FILES, { minLength: 1, maxLength: 1 })), { minLength: 2, maxLength: 10 }),
        fc.array(fc.nat(30), { maxLength: 100 }),
        (kinds, picks) => {
          const w = new World({ checkInvariants: true });
          kinds.forEach((k, i) => {
            const a = k === "unknown" ? { ...affected({ files: ["?"] }), complete: false } : affected({ files: k });
            w.enqueue({ id: `u${i}`, affected: a });
            // checkStateInvariants (run after every step) throws "parallel.unknown" on a violation.
            const tracks = Object.values(w.state.tracks);
            const unknownTrack = tracks.find((t) =>
              t.chain.some((b) => w.state.batches[b]?.units.some((u) => u.changeIds.some((id) => w.state.entries[id]?.affected?.complete === false))),
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
      fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 2, max: 8 }), (perTick, ciTicks) => {
        // One track, no speculation: the scheduling order alone decides who goes next.
        const config = queueConfig({ maxTracks: 1, maxSpeculationDepth: 1, maxBatchSize: 1, agingStepMs, features: { conflictGraph: false } });
        const w = new World({ config, checkInvariants: false });
        w.enqueue({ id: "slow", affected: affected({ files: ["x"] }), lane: 2, session: "s" });
        let n = 0;
        let enteredAt: number | null = null;
        for (let minute = 0; minute < 6 * 60 && enteredAt === null; minute++) {
          for (let j = 0; j < perTick; j++) w.enqueue({ id: `sec${n++}`, affected: affected({ files: ["x"] }), priority: "security", session: `f${n % 3}` });
          // CI finishes a run every `ciTicks` minutes.
          if (minute % ciTicks === 0) while (w.outstanding > 0) w.complete(0);
          w.tick(60_000);
          if (w.state.entries.slow?.firstBatchAt !== null) enteredAt = w.state.entries.slow?.firstBatchAt ?? null;
        }
        expect(enteredAt).not.toBeNull();
        // rank 4 → 1 after 3 aging steps; then it is the oldest entry of its class.
        expect(enteredAt ?? Infinity).toBeLessThanOrEqual(3 * agingStepMs + (ciTicks + 2) * 60_000 * 2);
      }),
      { numRuns: 60 },
    );
  });

  it("lanes never decrease even when the resolver reports a lower lane", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(30), { maxLength: 60 }), (picks) => {
        const w = new World({ resolverLowersLane: true });
        w.enqueue({ id: "a", affected: affected({ files: ["s.ts"] }), lane: 1 });
        w.enqueue({ id: "b", affected: affected({ files: ["s.ts"] }), lane: 2, textualWith: ["a"] });
        w.enqueue({ id: "c", affected: affected({ files: ["s.ts"] }), lane: 1, semanticWith: ["a"] });
        let k = 0;
        w.drain(5_000, (n) => picks[k++ % Math.max(1, picks.length)] ?? n);
        expect(w.violations).toEqual([]);
        expect(w.state.entries.b?.lane).toBe(2);
        expect(w.state.entries.c?.lane).toBeGreaterThanOrEqual(1);
        expect(w.commands.some((c) => c.type === "Telemetry" && c.kind === "lane-downgrade-ignored")).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
