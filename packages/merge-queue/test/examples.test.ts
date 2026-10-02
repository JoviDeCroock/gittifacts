/**
 * Example tests for the mechanisms of §4: bisection, revalidation, flake quarantine, conflict
 * resolution, freezes, the CAS guard, stacks, fairness and the read-side queries.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type CommandOf,
  entryStatus,
  InvariantViolation,
  queueConfig,
  step,
} from "../src/index.js";
import { affected, World } from "./harness.js";

const cmds = <T extends Command["type"]>(w: World, type: T): CommandOf<T>[] =>
  w.commands.filter((c): c is CommandOf<T> => c.type === type);
const emitted = (w: World, type: string) =>
  w.commands
    .filter((c) => c.type === "Emit" && c.event.type === type)
    .map((c) => (c.type === "Emit" ? c.event : null));
const human = { principalId: "human-1", kind: "human" as const, signature: "sig" };

describe("bisection (§4.3)", () => {
  it("finds the culprit with parallel prefix probes, ejects only it, and re-forms the rest", () => {
    const config = queueConfig({ maxBatchSize: 4, bisectProbes: 3, maxSpeculationDepth: 1 });
    const w = new World({ config, precompute: true });
    // z occupies the track; a..d queue up behind it and form one batch.
    w.enqueue({ id: "z", affected: affected({ files: ["x.ts"], tests: ["tx"] }) });
    for (const id of ["a", "b", "c", "d"])
      w.enqueue({ id, affected: affected({ files: ["x.ts"], tests: ["tx"] }), bad: id === "c" });
    w.drain();
    expect(cmds(w, "BuildBatchTree")[1]?.entries.map((e) => e.changeId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(w.violations).toEqual([]);
    // One failing batch → re-check (reproduced on the tree, green on main) → 3 probes in parallel.
    const probes = cmds(w, "StartBatchRun").filter((r) => r.kind === "probe");
    expect(probes.map((p) => p.entries.length).sort()).toEqual([1, 2, 3]);
    expect(cmds(w, "RunFlakeRecheck")[0]?.tests).toEqual(["test:c"]);
    expect(w.ejected.get("c")).toBe("tests-failed");
    expect(new Set(w.merged)).toEqual(new Set(["z", "a", "b", "d"]));
    const ejected = emitted(w, "ejected")[0];
    expect(ejected?.type === "ejected" && ejected.reason.fix.call).toBe(
      'open_workspace({ changeId: "c" })',
    );
    expect(ejected?.type === "ejected" && ejected.reason.failingTests).toEqual(["test:c"]);
  });

  it("re-roots descendants immediately when an ancestor batch fails", () => {
    const config = queueConfig({ maxBatchSize: 1, maxSpeculationDepth: 3 });
    const w = new World({ config, precompute: true });
    for (const id of ["a", "b", "c"])
      w.enqueue({ id, affected: affected({ files: ["x.ts"] }), bad: id === "a" });
    // Three batches speculated on top of each other.
    expect(cmds(w, "BuildBatchTree").length).toBe(1);
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.ejected.get("a")).toBe("tests-failed");
    expect(new Set(w.merged)).toEqual(new Set(["b", "c"]));
    expect(cmds(w, "CancelBatchRun").length).toBeGreaterThan(0);
  });
});

describe("independent tracks and revalidation (§4.2)", () => {
  it("runs disjoint changes in parallel tracks and revalidates the stale one on impacted targets only", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.enqueue({ id: "b", affected: affected({ files: ["b.ts"], tests: ["tb"] }) });
    expect(Object.keys(w.state.tracks).length).toBe(2);
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["a", "b"]);
    const landing = cmds(w, "StartBatchRun").find((r) => r.kind === "landing");
    expect(landing?.targets).toEqual(["tb"]);
    const cas = cmds(w, "Cas")[1];
    expect(cas?.evidence.verdict.scope).toEqual(["tb"]);
    expect(cas?.evidence.carried[0]?.disjointFrom).toEqual(["a"]);
    expect(cas?.evidence.carried[0]?.verdict.scope).toBe("all");
  });

  it("a change conflicting with two tracks merges them (no drain): its batch carries both on main", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["s.ts"] }) });
    w.enqueue({ id: "b", affected: affected({ modules: ["m"], files: ["t.ts"] }) });
    expect(Object.keys(w.state.tracks).length).toBe(2);
    w.enqueue({ id: "c", affected: affected({ files: ["s.ts"], modules: ["m"] }) });
    // c speculates right away on a merge batch rebuilt on main with a and b applied first.
    const st = entryStatus(w.state, "c", w.now);
    expect(st?.state).toBe("speculating");
    expect(Object.keys(w.state.tracks).length).toBe(1);
    const build = cmds(w, "BuildBatchTree").find((x) => x.entries.some((e) => e.changeId === "c"));
    expect(build?.entries.map((e) => e.changeId)).toEqual(["a", "b", "c"]);
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged.indexOf("c")).toBe(2);
  });

  it("independent work speculates in parallel next to a conflicting chain (siblings, not a queue)", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["s.ts"], modules: ["m1", "m2"] }) });
    w.enqueue({ id: "b", affected: affected({ files: ["x.ts"], modules: ["m1"] }) });
    w.enqueue({ id: "c", affected: affected({ files: ["y.ts"], modules: ["m2"] }) });
    // b and c both build on a's tip but not on each other.
    const parent = (id: string) => w.state.batches[w.state.entries[id]?.batchId ?? ""]?.parentId;
    expect(parent("b")).toBe(w.state.entries.a?.batchId);
    expect(parent("c")).toBe(w.state.entries.a?.batchId);
    w.drain();
    expect(w.violations).toEqual([]);
    expect(new Set(w.merged)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("flaky tests (§4.7)", () => {
  it("a failure that passes when re-run on the same tree is a flake: no eject, recorded as retried", () => {
    const w = new World({ flakeRate: 1, flakeRepeat: 0, precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["a"]);
    expect(cmds(w, "Cas")[0]?.evidence.verdict.flakyRetried.length).toBe(1);
    expect(cmds(w, "OpenPlan")).toEqual([]);
  });

  it("a test failing on main's head too is quarantined (audited, Plan opened), never counted as passing, and raises the lane", () => {
    const w = new World({ flakeRate: 1, flakeRepeat: 1, precompute: true });
    w.enqueue({
      id: "a",
      affected: affected({ files: ["a.ts"], tests: ["flaky:0", "flaky:1", "flaky:2"] }),
      lane: 0,
    });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["a"]);
    expect(w.ejected.size).toBe(0);
    const plan = cmds(w, "OpenPlan")[0];
    expect(plan?.kind).toBe("fix-flaky-test");
    expect(cmds(w, "Audit").some((a) => a.action === "merge-queue.test-quarantined")).toBe(true);
    const cas = cmds(w, "Cas")[0];
    expect(cas?.evidence.quarantined).toContain(plan?.test);
    expect(cas?.evidence.laneRaises.find((r) => r.changeId === "a")?.lane).toBe(1);
    // Lane 0 → 1 needs a human approval before it can land.
    expect(cmds(w, "RequestApproval")[0]?.changeId).toBe("a");
    expect(w.state.entries.a?.lane).toBe(1);
  });
});

describe("conflict resolution (§4.4)", () => {
  it("resolves a textual conflict instead of ejecting; the lane only rises", () => {
    const w = new World({ precompute: true, resolverLowersLane: true });
    w.enqueue({ id: "a", affected: affected({ files: ["s.ts"] }), lane: 1 });
    w.drain();
    w.enqueue({ id: "b", affected: affected({ files: ["s.ts"] }), lane: 1, textualWith: ["a"] });
    // b was authored before a landed.
    w.authoredOn.set("b", new Set());
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["a", "b"]);
    const req = cmds(w, "RequestResolution")[0];
    expect(req?.kind).toBe("textual");
    expect(req?.excludePrincipals).toContain("agent-a");
    expect(emitted(w, "resolving_conflict").length).toBe(1);
    expect(emitted(w, "resolution_ready").length).toBe(1);
    expect(w.state.entries.b?.lane).toBe(1);
  });

  it("ejects after two failed resolutions with a fix hint for the author", () => {
    const w = new World({ precompute: true, resolverSuccess: 0 });
    w.enqueue({ id: "a", affected: affected({ files: ["s.ts"] }) });
    w.drain();
    w.enqueue({ id: "b", affected: affected({ files: ["s.ts"] }), textualWith: ["a"] });
    w.authoredOn.set("b", new Set());
    w.drain();
    expect(cmds(w, "RequestResolution").map((r) => r.attempt)).toEqual([1, 2]);
    const ev = emitted(w, "ejected")[0];
    expect(ev?.type === "ejected" && ev.reason.code).toBe("textual-conflict");
    expect(ev?.type === "ejected" && ev.reason.upstream).toEqual(["a"]);
    expect(ev?.type === "ejected" && ev.reason.fix.command).toMatch(/rebase/);
  });

  it("a resolution outside the conflict hunks goes to Lane 1 and needs a human (not the resolver)", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["s.ts"] }) });
    w.drain();
    w.enqueue({ id: "b", affected: affected({ files: ["s.ts"] }), textualWith: ["a"], lane: 0 });
    w.authoredOn.set("b", new Set());
    // Run until the resolver is asked, then answer by hand.
    while (!w.pending.some((p) => p.cmd.type === "RequestResolution")) w.complete(0);
    w.pending = w.pending.filter((p) => p.cmd.type !== "RequestResolution");
    w.send({
      type: "ResolutionResult",
      changeId: "b",
      attempt: 1,
      resolverId: "resolver-9",
      outcome: {
        status: "resolved",
        newHeadSha: "f".repeat(40),
        lane: 0,
        outsideHunks: true,
        blamedUpstream: "a",
        resolutionRef: "res:1",
        affected: affected({ files: ["s.ts"] }),
      },
    });
    expect(w.state.entries.b?.lane).toBe(1);
    expect(w.state.entries.b?.approvalRequired).toBe(true);
    const req = cmds(w, "RequestApproval").at(-1);
    expect(req?.excludePrincipals).toEqual(expect.arrayContaining(["agent-a", "resolver-9"]));
    // The resolver can't approve its own resolution.
    w.send({
      type: "Approved",
      changeId: "b",
      lane: 1,
      approver: { principalId: "resolver-9", kind: "human" },
    });
    expect(w.state.entries.b?.approvalRequired).toBe(true);
    w.send({
      type: "Approved",
      changeId: "b",
      lane: 1,
      approver: { principalId: "human-2", kind: "human" },
    });
    expect(w.state.entries.b?.approvalRequired).toBe(false);
  });
});

describe("freezes (§4.9)", () => {
  it("post-merge failure freezes; only the revert lands; the revert thaws and invalidates batches built on the bad main", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "bad", affected: affected({ files: ["x.ts"] }) });
    w.drain();
    w.send({ type: "PostMergeCheckFailed", sha: w.mainSha, checks: ["smoke"] });
    expect(emitted(w, "frozen").length).toBe(1);
    w.enqueue({ id: "n1", affected: affected({ files: ["y.ts"] }) });
    // n1 speculates but cannot land.
    for (let i = 0; i < 20 && w.outstanding > 0; i++) w.complete(0);
    expect(w.state.entries.n1?.state).toBe("passed");
    expect(w.merged).toEqual(["bad"]);
    w.enqueue({
      id: "r1",
      affected: affected({ files: ["x.ts"] }),
      priority: "revert",
      revertOf: "bad",
      automaticRevert: true,
    });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(w.merged).toEqual(["bad", "r1", "n1"]);
    const thawed = emitted(w, "thawed")[0];
    expect(thawed?.type === "thawed" && thawed.invalidatedBatches).toBeGreaterThan(0);
  });

  it("manual freeze and thaw are human-signed audit events; agents can't", () => {
    const w = new World();
    w.send({
      type: "Freeze",
      signer: { principalId: "agent-x", kind: "agent", signature: "s" },
      reason: "nope",
    });
    expect(w.state.freeze.reasons).toEqual([]);
    w.send({ type: "Freeze", signer: human, reason: "incident review" });
    expect(w.state.freeze.reasons[0]?.signer?.principalId).toBe("human-1");
    const audit = cmds(w, "Audit").find((a) => a.action === "merge-queue.frozen");
    expect(audit?.signature).toBe("sig");
    w.send({ type: "Thaw", signer: human, reason: "done" });
    expect(w.state.freeze.reasons).toEqual([]);
    expect(cmds(w, "Audit").find((a) => a.action === "merge-queue.thawed")?.principalId).toBe(
      "human-1",
    );
  });
});

describe("the CAS guard asserts instead of trusting", () => {
  it("refuses to land a tree whose verdict is for another tree", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"] }) });
    while (!w.pending.some((p) => p.cmd.type === "StartBatchRun")) w.complete(0);
    const s = structuredClone(w.state);
    const b = Object.values(s.batches)[0];
    if (b === undefined || b.treeSha === null || b.tipSha === null || b.baseSha === null)
      throw new Error("no batch");
    b.state = "passed";
    b.verdict = {
      treeSha: "0".repeat(40),
      commitSha: b.tipSha,
      baseSha: b.baseSha,
      scope: "all",
      runIds: ["x"],
      passed: true,
      failing: [],
      quarantined: [],
      flakyRetried: [],
    };
    expect(() => step(s, { type: "Tick" }, { now: 1 })).toThrow(InvariantViolation);
  });

  it("does not count a result reported for a different tree", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"] }) });
    while (!w.pending.some((p) => p.cmd.type === "StartBatchRun")) w.complete(0);
    const run = cmds(w, "StartBatchRun")[0];
    if (run === undefined) throw new Error("no run");
    w.pending = [];
    w.send({
      type: "BatchResult",
      batchId: run.batchId,
      runId: run.runId,
      treeSha: "0".repeat(40),
      outcome: "passed",
      failingTests: [],
      scope: "all",
    });
    expect(cmds(w, "Cas")).toEqual([]);
    expect(cmds(w, "StartBatchRun").length).toBe(2); // re-run on the right tree
  });

  it("never lands a direct batch on a partial (impacted-only) run", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"] }) });
    while (!w.pending.some((p) => p.cmd.type === "StartBatchRun")) w.complete(0);
    const s = structuredClone(w.state);
    const b = Object.values(s.batches)[0];
    if (b === undefined || b.treeSha === null || b.tipSha === null || b.baseSha === null)
      throw new Error("no batch");
    b.state = "passed";
    b.verdict = {
      treeSha: b.treeSha,
      commitSha: b.tipSha,
      baseSha: b.baseSha,
      scope: ["ta"],
      runIds: ["x"],
      passed: true,
      failing: [],
      quarantined: [],
      flakyRetried: [],
    };
    expect(() => step(s, { type: "Tick" }, { now: 1 })).toThrow(/cas.scope/);
  });
});

describe("stacks, plan groups and fairness (§4.5)", () => {
  it("lands an atomic stack in one CAS, dependency first", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "base", affected: affected({ files: ["a.ts"] }), landMode: "atomic" });
    w.enqueue({
      id: "top",
      affected: affected({ files: ["b.ts"] }),
      dependsOn: ["base"],
      landMode: "atomic",
    });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(cmds(w, "Cas").map((c) => c.entries.map((e) => e.changeId))).toEqual([["base", "top"]]);
  });

  it("holds a land-together plan group until every member is enqueued", () => {
    const w = new World({ precompute: true });
    w.enqueue({
      id: "g1",
      affected: affected({ files: ["a.ts"] }),
      plangroup: "P",
      landTogether: true,
      groupSize: 2,
    });
    w.drain(200);
    expect(w.state.entries.g1?.hold).toBe("group");
    w.enqueue({
      id: "g2",
      affected: affected({ files: ["b.ts"] }),
      plangroup: "P",
      landTogether: true,
      groupSize: 2,
    });
    w.drain();
    expect(cmds(w, "Cas").map((c) => c.entries.map((e) => e.changeId).sort())).toEqual([
      ["g1", "g2"],
    ]);
  });

  it("a runaway session can't starve others (fair queuing + in-flight cap)", () => {
    const config = queueConfig({
      maxInFlightPerSession: 2,
      maxSpeculationDepth: 2,
      maxBatchSize: 2,
    });
    const w = new World({ config, precompute: true, checkInvariants: false });
    for (let i = 0; i < 30; i++)
      w.enqueue({ id: `run${i}`, affected: affected({ files: ["x.ts"] }), session: "runaway" });
    w.enqueue({ id: "polite", affected: affected({ files: ["x.ts"] }), session: "polite" });
    w.drain();
    expect(w.merged.indexOf("polite")).toBeLessThan(6);
  });
});

describe("queries (§5)", () => {
  it("explains the wait and gives an ETA", () => {
    const w = new World({ precompute: true });
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"] }) });
    const st = entryStatus(w.state, "a", w.now);
    expect(st?.state).toBe("speculating");
    expect(st?.etaSeconds).toBeGreaterThan(0);
    expect(st?.reason).toMatch(/testing in batch/);
  });
});
