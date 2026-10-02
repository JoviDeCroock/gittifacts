import { describe, expect, it } from "vitest";
import {
  attributionScore,
  initialTrainState,
  type TrainCommand,
  TrainEvent,
  type TrainEventInput,
  type TrainState,
  trainStep,
} from "../src/index.js";
import { affected, World } from "./harness.js";

class Trains {
  state: TrainState = initialTrainState({ watchMs: 30 * 60_000, killWatchMs: 10 * 60_000 });
  now = 0;
  out: TrainCommand[] = [];
  send(e: TrainEventInput): TrainCommand[] {
    const r = trainStep(this.state, TrainEvent.parse(e), { now: this.now });
    this.state = r.state;
    this.out.push(...r.commands);
    return r.commands;
  }
  merged(id: string, worker: string, files: string[], flag = true) {
    return this.send({
      type: "ChangeMerged",
      changeId: id,
      sha: `sha-${id}`,
      deploysTo: [worker],
      flagKey: flag ? `change-${id}` : null,
      files,
    });
  }
  of<T extends TrainCommand["type"]>(type: T) {
    return this.out.filter((c): c is Extract<TrainCommand, { type: T }> => c.type === type);
  }
}

describe("deploy trains (§4.8)", () => {
  it("groups individually switchable changes with disjoint files into one train", () => {
    const t = new Trains();
    t.merged("a", "api", ["src/a.ts"]);
    // a's train started alone (nothing else pending yet); b and c queue for the next train.
    t.merged("b", "api", ["src/b.ts"]);
    t.merged("c", "api", ["src/c.ts"]);
    expect(t.of("StartDeployTrain").map((x) => x.changes.map((c) => c.changeId))).toEqual([["a"]]);
    const first = t.of("StartDeployTrain")[0];
    t.send({ type: "TrainDeployed", trainId: first?.trainId ?? "", versionId: "v1" });
    // One train at a time per Worker: b+c wait for the watch window.
    expect(t.of("StartDeployTrain").length).toBe(1);
    t.now += 30 * 60_000;
    t.send({ type: "Tick" });
    expect(t.of("StartDeployTrain").map((x) => x.changes.map((c) => c.changeId))).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });

  it("deploys a change that can't be switched off alone, and different Workers in parallel", () => {
    const t = new Trains();
    t.merged("w1", "web", ["web/x.ts"]);
    t.merged("u", "api", ["src/u.ts"], false);
    t.merged("v", "api", ["src/v.ts"]);
    expect(
      t.of("StartDeployTrain").map((x) => [x.worker, x.changes.map((c) => c.changeId)]),
    ).toEqual([
      ["web", ["w1"]],
      ["api", ["u"]],
    ]);
  });

  it("attributes a regression by stack frames, kills only that flag, and requests a revert", () => {
    const t = new Trains();
    t.state.workers.api = { pending: [], active: null, history: [] };
    // Three switchable changes merged before any train starts.
    t.state = {
      ...t.state,
      workers: {
        api: {
          active: null,
          history: [],
          pending: ["a", "b", "c"].map((id) => ({
            changeId: id,
            sha: `s${id}`,
            flagKey: `change-${id}`,
            files: [`src/${id}/index.ts`],
            modules: [],
            mergedAt: 0,
          })),
        },
      },
    };
    t.send({ type: "Tick" });
    const train = t.of("StartDeployTrain")[0];
    expect(train?.changes.map((c) => c.changeId)).toEqual(["a", "b", "c"]);
    t.send({ type: "TrainDeployed", trainId: train?.trainId ?? "", versionId: "v7" });
    t.now += 60_000;
    t.send({
      type: "IssueReported",
      worker: "api",
      versionId: "v7",
      issueId: "iss-1",
      frames: [
        { file: "node_modules/runtime.js" },
        { file: "src/b/index.ts" },
        { file: "src/b/util.ts" },
      ],
    });
    expect(t.of("KillFlag").map((k) => k.changeId)).toEqual(["b"]);
    expect(t.of("Emit").some((e) => e.event.type === "flag_killed")).toBe(true);
    t.send({ type: "RegressionCleared", trainId: train?.trainId ?? "", issueId: "iss-1" });
    expect(t.of("RequestRevert").map((r) => r.changeId)).toEqual(["b"]);
    expect(t.of("RollbackTrain")).toEqual([]);
    expect(t.state.attributionFailures).toBe(0);
    expect(t.state.trains[train?.trainId ?? ""]?.killed).toEqual(["b"]);
  });

  it("escalates to a train rollback when killing the most likely flag doesn't clear it", () => {
    const t = new Trains();
    t.merged("a", "api", ["src/a.ts"]);
    const a = t.of("StartDeployTrain")[0];
    t.send({ type: "TrainDeployed", trainId: a?.trainId ?? "", versionId: "v1" });
    t.now += 30 * 60_000;
    t.merged("b", "api", ["src/b.ts"]);
    t.merged("c", "api", ["src/c.ts"]);
    t.send({ type: "Tick" });
    const bc = t.of("StartDeployTrain")[1];
    t.send({ type: "TrainDeployed", trainId: bc?.trainId ?? "", versionId: "v2" });
    t.send({
      type: "IssueReported",
      worker: "api",
      versionId: "v2",
      issueId: "iss-2",
      frames: [{ file: "src/c.ts" }],
    });
    expect(t.of("KillFlag").map((k) => k.changeId)).toEqual(["c"]);
    t.now += 10 * 60_000;
    t.send({ type: "Tick" });
    expect(t.of("RollbackTrain").map((r) => r.trainId)).toEqual([bc?.trainId]);
    expect(t.state.attributionFailures).toBe(1);
  });

  it("scores frames transparently", () => {
    expect(
      attributionScore({ files: ["src/a/x.ts"] }, [
        { file: "src/a/x.ts" },
        { file: "src/a/y.ts" },
        { file: "z.ts" },
      ]),
    ).toBe(4);
  });
});

describe("Q5 acceptance shape: one of three Changes in a train throws in production", () => {
  it("only that Change's flag is killed, the other two stay live, and the queue freezes and thaws", () => {
    const q = new World({ precompute: true });
    const t = new Trains();
    const ids = ["a", "b", "c"];
    for (const id of ids)
      q.enqueue({
        id,
        affected: affected({ files: [`src/${id}.ts`], deploysTo: ["api"] }),
        flagKey: `change-${id}`,
      });
    // Hold deploys until all three merged so they ride one train.
    q.drain();
    expect(new Set(q.merged)).toEqual(new Set(ids));
    t.state = { ...t.state, workers: { api: { pending: [], active: "busy", history: [] } } };
    for (const c of q.commands) {
      if (c.type !== "Emit" || c.event.type !== "merged") continue;
      t.send({
        type: "ChangeMerged",
        changeId: c.event.changeId,
        sha: c.event.mergedSha,
        deploysTo: c.event.deploysTo,
        flagKey: c.event.flagKey,
        files: c.event.files,
      });
    }
    t.state = {
      ...t.state,
      workers: { api: { ...(t.state.workers.api ?? { pending: [], history: [] }), active: null } },
    };
    t.send({ type: "Tick" });
    const train = t.of("StartDeployTrain")[0];
    expect(train?.changes.length).toBe(3);
    t.send({ type: "TrainDeployed", trainId: train?.trainId ?? "", versionId: "v1" });
    t.send({
      type: "IssueReported",
      worker: "api",
      versionId: "v1",
      issueId: "boom",
      frames: [{ file: "src/b.ts" }],
    });
    t.send({ type: "RegressionCleared", trainId: train?.trainId ?? "", issueId: "boom" });
    expect(t.of("KillFlag").map((k) => k.changeId)).toEqual(["b"]);
    const revert = t.of("RequestRevert")[0];
    expect(revert?.changeId).toBe("b");
    // The automatic revert enters the queue: frozen until it lands, then thawed.
    q.enqueue({
      id: "revert-b",
      affected: affected({ files: ["src/b.ts"], deploysTo: ["api"] }),
      priority: "revert",
      revertOf: "b",
      automaticRevert: true,
    });
    expect(q.state.freeze.reasons.map((r) => r.kind)).toEqual(["revert-in-progress"]);
    q.enqueue({ id: "d", affected: affected({ files: ["src/d.ts"] }) });
    q.drain();
    expect(q.violations).toEqual([]);
    expect(q.merged.slice(3)).toEqual(["revert-b", "d"]);
    expect(q.state.freeze.reasons).toEqual([]);
    expect(t.state.trains[train?.trainId ?? ""]?.killed).toEqual(["b"]);
  });
});
