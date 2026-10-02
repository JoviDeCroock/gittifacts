import fc from "fast-check";
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

describe("train watch window", () => {
  it("follows the deploy-time window carried by TrainDeployed (default: config.watchMs)", () => {
    const t = new Trains();
    t.merged("a", "api", ["src/a.ts"]);
    const a = t.of("StartDeployTrain")[0]?.trainId ?? "";
    t.send({ type: "TrainDeployed", trainId: a, versionId: "v1", watchMs: 7 * 60_000 });
    expect(t.state.trains[a]?.watchUntil).toBe(7 * 60_000);
    t.now = 7 * 60_000 - 1;
    t.send({ type: "Tick" });
    expect(t.state.trains[a]?.state).toBe("watching");
    t.now = 7 * 60_000;
    t.send({ type: "Tick" });
    expect(t.state.trains[a]?.state).toBe("released");
    t.merged("b", "api", ["src/b.ts"]);
    const b = t.of("StartDeployTrain")[1]?.trainId ?? "";
    t.send({ type: "TrainDeployed", trainId: b, versionId: "v2" });
    expect(t.state.trains[b]?.watchUntil).toBe(t.now + 30 * 60_000);
  });
});

describe("failed deploys", () => {
  it("a failed train frees its Worker and is not retried; the next merge deploys", () => {
    const t = new Trains();
    t.merged("a", "api", ["src/a.ts"]);
    const a = t.of("StartDeployTrain")[0]?.trainId ?? "";
    const cmds = t.send({ type: "TrainDeployFailed", trainId: a, message: "10210" });
    expect(cmds.filter((c) => c.type === "StartDeployTrain")).toEqual([]);
    expect(t.state.trains[a]?.state).toBe("failed");
    expect(t.state.workers.api?.active).toBeNull();
    expect(cmds.find((c) => c.type === "Audit")).toMatchObject({
      action: "deploy.train-failed",
      payload: { message: "10210", changes: ["a"] },
    });
    t.merged("b", "api", ["src/b.ts"]);
    expect(t.of("StartDeployTrain").map((x) => x.changes.map((c) => c.changeId))).toEqual([
      ["a"],
      ["b"],
    ]);
  });
});

describe("regressions always end in a revert (platform spec §4F.3, §4.8)", () => {
  const deployFirst = (t: Trains, versionId = "v1") => {
    const train = t.of("StartDeployTrain")[0];
    t.send({ type: "TrainDeployed", trainId: train?.trainId ?? "", versionId });
    return train?.trainId ?? "";
  };

  it("a single-change train kills the flag, rolls back and requests the revert at once", () => {
    const t = new Trains();
    t.merged("a", "api", ["src/a.ts"]);
    const trainId = deployFirst(t);
    const cmds = t.send({
      type: "IssueReported",
      worker: "api",
      versionId: "v1",
      issueId: "i1",
      frames: [],
    });
    expect(cmds.map((c) => c.type).filter((x) => x !== "Audit" && x !== "Emit")).toEqual([
      "KillFlag",
      "RollbackTrain",
      "RequestRevert",
    ]);
    expect(t.of("KillFlag")[0]).toMatchObject({ changeId: "a", flagKey: "change-a" });
    expect(t.of("RequestRevert")[0]?.changeId).toBe("a");
    expect(t.state.trains[trainId]?.state).toBe("rolling-back");
    expect(t.state.trains[trainId]?.attributions[0]).toMatchObject({
      method: "single-change-train",
      confirmed: true,
    });
    // A late "cleared" signal changes nothing; the rollback completes the train.
    expect(t.send({ type: "RegressionCleared", trainId, issueId: "i1" })).toEqual([]);
    t.send({ type: "RollbackDone", trainId });
    expect(t.state.trains[trainId]?.state).toBe("rolled-back");
    expect(t.of("RequestRevert")).toHaveLength(1);
  });

  it("a Change without a flag rolls back and is reverted (nothing to kill)", () => {
    const t = new Trains();
    t.merged("u", "api", ["src/u.ts"], false);
    deployFirst(t);
    t.send({ type: "IssueReported", worker: "api", versionId: "v1", issueId: "i1", frames: [] });
    expect(t.of("KillFlag")).toEqual([]);
    expect(t.of("RollbackTrain")).toHaveLength(1);
    expect(t.of("RequestRevert").map((r) => r.changeId)).toEqual(["u"]);
  });

  it("a multi-change train whose kill does not clear rolls back and reverts the attributed Change", () => {
    const t = new Trains();
    t.state = {
      ...t.state,
      workers: {
        api: {
          active: null,
          history: [],
          pending: ["b", "c"].map((id) => ({
            changeId: id,
            sha: `s${id}`,
            flagKey: `change-${id}`,
            files: [`src/${id}.ts`],
            modules: [],
            mergedAt: 0,
          })),
        },
      },
    };
    t.send({ type: "Tick" });
    deployFirst(t, "v2");
    t.send({
      type: "IssueReported",
      worker: "api",
      versionId: "v2",
      issueId: "i2",
      frames: [{ file: "src/c.ts" }],
    });
    expect(t.of("KillFlag").map((k) => k.changeId)).toEqual(["c"]);
    expect(t.of("RequestRevert")).toEqual([]);
    t.now += 10 * 60_000;
    t.send({ type: "Tick" });
    expect(t.of("RollbackTrain")).toHaveLength(1);
    expect(t.of("RequestRevert").map((r) => r.changeId)).toEqual(["c"]);
  });
});

describe("train regression properties", () => {
  const changeArb = fc.record({
    flag: fc.boolean(),
    files: fc.subarray(["src/a.ts", "src/b.ts", "src/c.ts", "src/d/x.ts", "src/d/y.ts"], {
      minLength: 1,
      maxLength: 2,
    }),
  });

  it("every regression ends with a revert request for the attributed Change; single-change trains get all three commands at once", () => {
    fc.assert(
      fc.property(
        fc.array(changeArb, { minLength: 1, maxLength: 4 }),
        fc.array(fc.constantFrom("src/a.ts", "src/b.ts", "src/c.ts", "src/d/x.ts", "lib.js"), {
          maxLength: 4,
        }),
        fc.boolean(),
        (changes, frameFiles, clears) => {
          const t = new Trains();
          // Merge everything before the first train starts, so trains group what they can.
          t.state = {
            ...t.state,
            workers: {
              api: {
                active: null,
                history: [],
                pending: changes.map((c, i) => ({
                  changeId: `c${i}`,
                  sha: `s${i}`,
                  flagKey: c.flag ? `change-c${i}` : null,
                  files: c.files,
                  modules: [],
                  mergedAt: i,
                })),
              },
            },
          };
          t.send({ type: "Tick" });
          const start = t.of("StartDeployTrain")[0];
          if (start === undefined) throw new Error("no train started");
          t.send({ type: "TrainDeployed", trainId: start.trainId, versionId: "v1" });
          const cmds = t.send({
            type: "IssueReported",
            worker: "api",
            versionId: "v1",
            issueId: "i1",
            frames: frameFiles.map((file) => ({ file })),
          });
          const killed = cmds.find((c) => c.type === "KillFlag");
          if (start.changes.length === 1) {
            const only = start.changes[0];
            const types = cmds.map((c) => c.type);
            expect(types).toContain("RollbackTrain");
            expect(types.includes("KillFlag")).toBe(only?.flagKey !== null);
            const reverts = cmds.filter((c) => c.type === "RequestRevert");
            expect(reverts.map((r) => r.changeId)).toEqual([only?.changeId]);
            return;
          }
          // Multi-change train: the most likely flag is killed first, then either outcome.
          if (killed === undefined || killed.type !== "KillFlag") throw new Error("no kill");
          if (clears) t.send({ type: "RegressionCleared", trainId: start.trainId, issueId: "i1" });
          else {
            t.now += 10 * 60_000;
            t.send({ type: "Tick" });
            expect(t.of("RollbackTrain")).toHaveLength(1);
          }
          expect(t.of("RequestRevert").map((r) => r.changeId)).toEqual([killed.changeId]);
        },
      ),
      { numRuns: 300 },
    );
  });
});
