/**
 * Properties of the speculation mechanisms the simulator kept (§4.3, §8): the tree-keyed result
 * cache, direct carrying with one-level re-speculation, and early landing. The random workloads of
 * properties.test.ts (which run the default configuration) run under each alternative, with extra
 * per-step checks of what each mechanism must never do.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Batch, type QueueState, queueConfig } from "../src/index.js";
import type { World } from "./harness.js";
import { checkRun, opArb, run, specArb } from "./prop-helpers.js";

const RUNS = Number(process.env.FC_RUNS ?? 150);

function isActive(s: QueueState, b: Batch | undefined): b is Batch {
  return (
    b !== undefined &&
    b.kind === "chain" &&
    s.tracks[b.trackId ?? ""]?.chain.includes(b.id) === true
  );
}

function own(b: Batch): string[] {
  return b.units.flatMap((u) => u.changeIds);
}

/** Per-step checks (plain conditions; `expect` only on a failure: thousands of steps per run). */
function stepChecker() {
  const fail = (msg: string): void => {
    expect.fail(msg);
  };
  return (w: World): void => {
    const s = w.state;
    // A CAS lands only batches whose full run passed: early landing never lands a running one.
    if (s.cas !== null) {
      const b = s.batches[s.cas.batchId];
      const members = b?.kind === "landing" ? b.members.map((m) => s.batches[m]) : [b];
      for (const m of members)
        if (m === undefined || m.verdict?.passed !== true || m.verdict.scope !== "all")
          fail(`CAS ${s.cas.casId} lands ${m?.id} without its full passing run`);
    }
    // A cached result is filed under exactly the tree it ran on.
    for (const [tree, r] of Object.entries(s.results))
      if (r.verdict.treeSha !== tree) fail(`result for ${r.verdict.treeSha} filed under ${tree}`);
    if (!s.config.features.directCarry) return;
    // Direct carrying: every carried entry is still on its way (held by an active batch, waiting
    // to be placed again, or merged), and no two batches carry each other (acyclic order).
    const holder = new Map<string, Batch>();
    for (const b of Object.values(s.batches))
      if (isActive(s, b)) for (const id of own(b)) holder.set(id, b);
    for (const b of new Set(holder.values())) {
      if (b.state === "landing") continue;
      for (const x of b.carried) {
        const e = s.entries[x];
        const ok =
          e !== undefined &&
          (e.state === "merged" ||
            holder.has(x) ||
            (e.state === "waiting" && e.hold !== "approval" && e.waitFor.length === 0));
        if (!ok) fail(`${b.id} carries ${x} (${e?.state}/${e?.hold})`);
      }
    }
    const mark = new Map<string, number>();
    const visit = (b: Batch, depth: number): void => {
      const m = mark.get(b.id);
      if (m === 2) return;
      if (m === 1 || depth > 500) {
        fail(`carry cycle through ${b.id}`);
        return;
      }
      mark.set(b.id, 1);
      for (const x of b.carried) {
        const h = holder.get(x);
        if (h !== undefined && h.id !== b.id) visit(h, depth + 1);
      }
      mark.set(b.id, 2);
    };
    for (const b of holder.values()) visit(b, 0);
  };
}

const VARIANTS: [string, Parameters<typeof queueConfig>[0]][] = [
  ["default (direct carrying, early landing, no hold)", {}],
  ["result cache off", { features: { resultCache: false } }],
  ["direct carrying with a 2-minute hold", { batchHoldMs: 120_000 }],
  ["tip-built speculation (no direct carrying)", { features: { directCarry: false } }],
  [
    "tip-built, held batches, early landing",
    { batchHoldMs: 120_000, features: { directCarry: false, earlyLanding: true } },
  ],
  ["no early landing", { features: { earlyLanding: false } }],
];

describe("speculation mechanisms keep every invariant", () => {
  it.each(VARIANTS)("%s", (_name, cfg) => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 1, maxLength: 12 }),
        fc.array(opArb, { maxLength: 80 }),
        fc.array(fc.nat(50), { maxLength: 200 }),
        fc.constantFrom(0, 0.1, 0.3),
        (specs, ops, picks, flakeRate) => {
          const { w } = run(specs, ops, picks, {
            flakeRate,
            config: queueConfig(cfg),
            onStep: stepChecker(),
          });
          checkRun(w);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
