import type { EvidenceItem, RedGreenProof, TestRun } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { preexistingStopFor } from "../src/postprocess.js";
import { summarizeEvidenceItem } from "../src/prompt.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const run = (over: Partial<TestRun> = {}): TestRun => ({
  id: "test-run",
  kind: "test-run",
  status: "ok",
  sha: HEAD,
  step: "test",
  runner: "vitest@4",
  passed: 10,
  failed: 2,
  skipped: 0,
  durationMs: 1,
  failures: [
    { name: "test/a.test.ts > old", message: "x" },
    { name: "test/b.test.ts > new", message: "\u001b[31my\u001b[39m" },
  ],
  preExisting: ["test/a.test.ts > old"],
  baseline: { sha: BASE, status: "ok", source: "cache" },
  selection: { mode: "affected", reason: "2 test file(s)", files: 2 },
  ...over,
});

const proof: RedGreenProof = {
  id: "red-green",
  kind: "red-green",
  status: "ok",
  tests: [],
  base: { sha: BASE, results: [] },
  head: { sha: HEAD, results: [] },
  verdict: "no-tests",
  preExisting: [{ id: "test/c.test.ts > older", file: "test/c.test.ts", name: "older" }],
};

describe("pre-existing failures in the tour", () => {
  it("get one platform stop that cites the evidence and claims nothing is proven", () => {
    const stop = preexistingStopFor([run(), proof]);
    expect(stop).toMatchObject({ kind: "other", verdict: "unproven", hunkRefs: [] });
    expect(stop?.title).toBe("2 tests already fail on the base commit (not counted)");
    expect(stop?.why).toContain(`on base ${BASE.slice(0, 12)}`);
    expect(stop?.why).toContain("test/a.test.ts > old");
    expect(stop?.evidenceRefs).toEqual(["test-run", "red-green"]);
  });

  it("is absent without pre-existing failures or without a usable baseline", () => {
    expect(preexistingStopFor([run({ preExisting: [] })])).toBeNull();
    const items: EvidenceItem[] = [run({ baseline: { sha: BASE, status: "unavailable" } })];
    expect(preexistingStopFor(items)).toBeNull();
  });

  it("the prompt separates new failures from pre-existing ones and drops colour codes", () => {
    const line = summarizeEvidenceItem(run());
    expect(line).toContain("ran 2 affected test file(s)");
    expect(line).toContain("new failures: test/b.test.ts > new");
    expect(line).toContain(
      `pre-existing on base ${BASE.slice(0, 12)} (not counted): test/a.test.ts > old`,
    );
    expect(summarizeEvidenceItem(proof)).toContain(
      "pre-existing (fail identically on base and head",
    );
    const noted = summarizeEvidenceItem(
      run({ status: "error", note: "\u001b[32mINFO\u001b[39m boom" }),
    );
    expect(noted).toContain("note: INFO boom");
  });
});
