/**
 * The resolver eval corpus (fixtures/conflicts) through the whole pipeline, with a scripted model
 * that answers each case's known-correct resolution: real git repositories, the real runner
 * (merge-attempt, apply-resolution), the resolver's validation, patching and scope computation,
 * the cases' expected-behaviour tests, and the lane floor. scripts/eval.ts runs the same pipeline
 * with a real model (not part of `pnpm test`).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { EvidenceItem } from "@app/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRunner,
  type CaseResult,
  evaluateCase,
  listCases,
  scratchRoot,
  scriptedClient,
} from "../scripts/lib/corpus.js";

const cases = listCases();
const results = new Map<string, CaseResult>();
let root = "";

beforeAll(async () => {
  root = scratchRoot("gittifacts-resolver-corpus-");
  const bundle = buildRunner(join(root, "runner"));
  // Four at a time: each case is its own repository.
  for (let i = 0; i < cases.length; i += 4) {
    const batch = await Promise.all(
      cases
        .slice(i, i + 4)
        .map((c) => evaluateCase(c, { bundle, root, budgetUsd: 0.5, client: scriptedClient })),
    );
    for (const r of batch) results.set(r.name, r);
  }
}, 600_000);

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("the corpus", () => {
  it("has at least 10 textual and 3 semantic cases", () => {
    expect(cases.filter((c) => c.spec.kind === "textual").length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.spec.kind === "semantic").length).toBeGreaterThanOrEqual(3);
  });

  it("resolves every case with zero lane downgrades", () => {
    const failed = [...results.values()].filter((r) => !r.success);
    expect(failed.map((r) => `${r.name}: ${r.failure}`)).toEqual([]);
    expect([...results.values()].filter((r) => r.downgrade)).toEqual([]);
    expect(results.size).toBe(cases.length);
  });
});

describe.each(cases.map((c) => [c.name, c] as const))("%s", (name, c) => {
  it("passes its expected-behaviour checks after the resolution", () => {
    const r = results.get(name)!;
    expect(r.failure).toBeNull();
    expect(r.checks?.failed).toBe(0);
    expect(r.checks?.passed).toBeGreaterThan(0);
  });

  it("records valid evidence with the mechanically computed scope and culprit", () => {
    const r = results.get(name)!;
    const outcome = r.outcome!;
    expect(outcome.status).toBe("resolved");
    expect(EvidenceItem.safeParse(outcome.evidence).success).toBe(true);
    expect(outcome.evidence.resolver.principalId).toBe("system:resolver");
    expect(r.outside).toBe(c.spec.expect.outsideHunks);
    expect(r.culprit).toBe(c.spec.expect.culprit);
    expect(outcome.evidence.attempts).toBe(1);
  });

  it("never lowers the lane; edits outside the hunks or semantic fixes raise it", () => {
    const r = results.get(name)!;
    expect(r.lanes).not.toBeNull();
    const lanes = r.lanes!;
    expect(lanes.final).toBeGreaterThanOrEqual(lanes.before);
    expect(lanes.final).toBeGreaterThanOrEqual(lanes.merged);
    if (c.spec.expect.outsideHunks || c.spec.kind === "semantic")
      expect(lanes.merged).toBeGreaterThanOrEqual(1);
  });
});
