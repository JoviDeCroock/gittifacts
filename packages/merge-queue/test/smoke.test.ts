import { describe, expect, it } from "vitest";
import { affected, World } from "./harness.js";

describe("smoke", () => {
  it("lands independent and conflicting changes", () => {
    const w = new World();
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.enqueue({ id: "b", affected: affected({ files: ["b.ts"], tests: ["tb"] }) });
    w.enqueue({ id: "c", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(new Set(w.merged)).toEqual(new Set(["a", "b", "c"]));
    expect(w.refs.size).toBe(0);
  });
  it("ejects a bad change and lands the rest", () => {
    const w = new World();
    for (const id of ["a", "b", "c", "d"])
      w.enqueue({ id, affected: affected({ files: ["x.ts"], tests: ["tx"] }), bad: id === "c" });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(new Set(w.merged)).toEqual(new Set(["a", "b", "d"]));
    expect(w.ejected.get("c")).toBe("tests-failed");
  });
});

describe("build timeout", () => {
  it("rebuilds a batch whose tree build was dropped, after buildTimeoutMs, not runTimeoutMs", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.tick(1_000);
    const builds = () => w.pending.filter((p) => p.cmd.type === "BuildBatchTree");
    expect(builds(), JSON.stringify(w.pending.map((p) => p.cmd.type))).toHaveLength(1);
    // The shell gave up on it (dropped after its retries): nothing ever answers.
    w.pending = w.pending.filter((p) => p.cmd.type !== "BuildBatchTree");
    w.tick(14 * 60_000);
    expect(builds()).toHaveLength(0);
    w.tick(2 * 60_000); // 16 min: past the 15 min build timeout, far below the 90 min run timeout
    expect(builds()).toHaveLength(1);
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["a"]);
  });
});
