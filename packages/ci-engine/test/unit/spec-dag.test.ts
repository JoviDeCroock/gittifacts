import { describe, expect, it } from "vitest";
import {
  ancestors,
  dependents,
  levelize,
  parentChain,
  reduceAfter,
  snapshotSources,
  topologicalOrder,
} from "../../src/plan/dag.js";
import { MAX_STEPS, parsePipelineSpec, type StepSpec } from "../../src/plan/spec.js";

const step = (name: string, parent: string | null = null, after: string[] = []): StepSpec => ({
  name,
  command: `run ${name}`,
  parent,
  after,
});

const spec = (steps: unknown[]) => ({ version: 1, source: "file", steps });

describe("parsePipelineSpec", () => {
  it("accepts a valid DAG and defaults warnings", () => {
    const r = parsePipelineSpec(
      spec([step("install"), step("test", "install"), step("build", "install", ["test"])]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.warnings).toEqual([]);
  });

  it("rejects duplicate names", () => {
    const r = parsePipelineSpec(spec([step("a"), step("a")]));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/duplicate step name "a"/);
  });

  it("rejects unknown parents and after entries", () => {
    const r = parsePipelineSpec(spec([step("a", "ghost"), step("b", null, ["nope"])]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/unknown step "ghost"/);
      expect(r.error).toMatch(/unknown step "nope"/);
    }
  });

  it("rejects cycles", () => {
    const r = parsePipelineSpec(spec([step("a", "c"), step("b", "a"), step("c", null, ["b"])]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dependency cycle/);
  });

  it("rejects self references", () => {
    const r = parsePipelineSpec(spec([step("a", "a")]));
    expect(r.ok).toBe(false);
  });

  it(`rejects more than ${MAX_STEPS} steps`, () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, (_, i) => step(`s${i}`));
    const r = parsePipelineSpec(spec(steps));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 50 steps/);
  });

  it("enforces command length, env and reserved names", () => {
    expect(parsePipelineSpec(spec([{ ...step("a"), command: "x".repeat(8193) }])).ok).toBe(false);
    expect(parsePipelineSpec(spec([{ ...step("a"), command: "   " }])).ok).toBe(false);
    expect(parsePipelineSpec(spec([{ ...step("a"), env: { ARTIFACTS_TOKEN: "x" } }])).ok).toBe(
      false,
    );
    expect(parsePipelineSpec(spec([step("prepare")])).ok).toBe(false);
    expect(parsePipelineSpec(spec([step("evidence:coverage")])).ok).toBe(false);
    expect(parsePipelineSpec(spec([{ ...step("a"), cwd: "../x" }])).ok).toBe(false);
    expect(parsePipelineSpec(spec([{ ...step("a"), cache: { inputs: ["/abs"] } }])).ok).toBe(false);
    expect(parsePipelineSpec(spec([{ ...step("a"), extra: true }])).ok).toBe(false);
    expect(parsePipelineSpec(spec([{ ...step("a"), timeoutMinutes: 31 }])).ok).toBe(false);
  });

  it("rejects oversized specs", () => {
    const env = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [`K${i}`, "v".repeat(1024)]),
    );
    const steps = Array.from({ length: 10 }, (_, i) => ({ ...step(`s${i}`), env }));
    const r = parsePipelineSpec(spec(steps));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bytes; the limit/);
  });
});

describe("DAG helpers", () => {
  const steps = [
    step("install"),
    step("lint", "install"),
    step("typecheck", "install"),
    step("test", "install"),
    step("build", "install", ["lint", "typecheck", "test"]),
    step("e2e", "build"),
    step("docs"),
  ];

  it("levelizes by longest path", () => {
    expect(levelize(steps)).toEqual([
      ["install", "docs"],
      ["lint", "typecheck", "test"],
      ["build"],
      ["e2e"],
    ]);
    expect(topologicalOrder(steps)).toEqual([
      "install",
      "docs",
      "lint",
      "typecheck",
      "test",
      "build",
      "e2e",
    ]);
  });

  it("finds ancestors, dependents and the parent chain", () => {
    expect([...ancestors(steps, "e2e")].sort()).toEqual([
      "build",
      "install",
      "lint",
      "test",
      "typecheck",
    ]);
    expect([...dependents(steps, "test")].sort()).toEqual(["build", "e2e"]);
    expect(parentChain(steps, "e2e").map((s) => s.name)).toEqual(["install", "build"]);
    expect([...snapshotSources(steps)].sort()).toEqual(["build", "install"]);
  });

  it("reduces after lists transitively", () => {
    const reduced = reduceAfter([
      step("a"),
      step("b", null, ["a"]),
      step("c", null, ["a", "b"]),
      step("d", "c", ["a", "c", "b"]),
    ]);
    expect(reduced.get("c")).toEqual(["b"]);
    expect(reduced.get("d")).toEqual([]);
  });

  it("throws on cycles in unvalidated input", () => {
    expect(() => levelize([step("a", "b"), step("b", "a")])).toThrow(/cycle/);
  });
});
