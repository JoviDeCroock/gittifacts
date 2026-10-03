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

describe("build errors", () => {
  const audits = (w: World, action: string) =>
    w.commands.filter((c) => c.type === "Audit" && c.action === action);
  const builds = (w: World) => w.pending.filter((p) => p.cmd.type === "BuildBatchTree");
  /** The shell gave up on the pending build: answer it with an errored RebaseResult. */
  const failBuild = (w: World, message: string) => {
    const p = builds(w)[0];
    if (p === undefined || p.cmd.type !== "BuildBatchTree") throw new Error("no build pending");
    w.pending = w.pending.filter((x) => x !== p);
    w.send({
      type: "RebaseResult",
      batchId: p.cmd.batchId,
      result: { status: "errored", message },
    });
  };

  it("rebuilds at once after an errored build (no wait for buildTimeoutMs) and lands", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.tick(1_000);
    failBuild(w, "Error: queue build job failed (500): scratch not ready");
    expect(builds(w)).toHaveLength(1);
    expect(audits(w, "merge-queue.build-errored")).toHaveLength(1);
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["a"]);
  });

  it("ejects with infra-error (the reason in the message) once the retries are used up", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.tick(1_000);
    for (let i = 0; i < 40 && builds(w).length > 0; i++) failBuild(w, "TypeError: fetch failed");
    expect(builds(w)).toHaveLength(0);
    expect(w.ejected.get("a")).toBe("infra-error");
    expect(w.state.entries.a?.ejectReason?.message).toContain("TypeError: fetch failed");
    expect(w.violations).toEqual([]);
  });

  it("audits a stall past the build timeout, naming the batch's changes", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.tick(1_000);
    w.pending = w.pending.filter((p) => p.cmd.type !== "BuildBatchTree");
    w.tick(16 * 60_000);
    const [timedOut] = audits(w, "merge-queue.batch-timed-out");
    expect(timedOut?.type === "Audit" ? timedOut.payload : null).toMatchObject({
      state: "building",
      limitMs: 15 * 60_000,
      changeIds: ["a"],
    });
  });
});
