/**
 * Deploy trains (§4.8): a second pure state machine, `trainStep(state, event, { now })`.
 *
 * - Merged Changes deploy per Worker (`deploysTo`). A train holds several Changes only if each is
 *   individually switchable (has its own flag) and their files are disjoint (so a stack frame
 *   points at exactly one of them). A Change that can't be switched off deploys alone.
 * - One train at a time per Worker: the next one waits until the watch window ends or the error
 *   budget clears. Trains for different Workers run in parallel.
 * - A regression (Workers Issues) is attributed to the most likely Change by version, stack frames
 *   and affected files; its flag is killed first. If the regression doesn't clear, the whole train
 *   rolls back. Every step is audited; an automatic revert of the attributed Change is requested.
 */
import { z } from "zod";
import { ChangeId, QueueEvent } from "./schema.js";

export const TrainConfig = z.object({
  /** Watch window after a train reaches production. */
  watchMs: z
    .number()
    .int()
    .min(1)
    .default(30 * 60_000),
  /** After killing a flag, how long the regression has to clear before the train rolls back. */
  killWatchMs: z
    .number()
    .int()
    .min(1)
    .default(10 * 60_000),
  maxTrainSize: z.number().int().min(1).max(64).default(8),
  historyLimit: z.number().int().min(1).default(50),
});
export type TrainConfig = z.infer<typeof TrainConfig>;

export const PendingDeploy = z.object({
  changeId: ChangeId,
  sha: z.string(),
  flagKey: z.string().nullable(),
  files: z.array(z.string()),
  modules: z.array(z.string()),
  mergedAt: z.number().int(),
});
export type PendingDeploy = z.infer<typeof PendingDeploy>;

export const Attribution = z.object({
  issueId: z.string(),
  changeId: ChangeId,
  /** Score per candidate Change (transparent). */
  scores: z.record(z.string(), z.number()),
  method: z.enum(["single-change-train", "flag-kill", "rollback"]),
  confirmed: z.boolean().nullable(),
  at: z.number().int(),
});
export type Attribution = z.infer<typeof Attribution>;

export const Train = z.object({
  id: z.string(),
  worker: z.string(),
  changes: z.array(PendingDeploy),
  state: z.enum([
    "deploying",
    "watching",
    "killing",
    "rolling-back",
    "released",
    "rolled-back",
    "failed",
  ]),
  versionId: z.string().nullable(),
  deployedAt: z.number().int().nullable(),
  watchUntil: z.number().int().nullable(),
  killed: z.array(ChangeId),
  regression: z
    .object({ issueId: z.string(), suspect: ChangeId, deadline: z.number().int() })
    .nullable(),
  attributions: z.array(Attribution),
});
export type Train = z.infer<typeof Train>;

export interface TrainState {
  config: TrainConfig;
  seq: number;
  workers: Record<string, { pending: PendingDeploy[]; active: string | null; history: string[] }>;
  trains: Record<string, Train>;
  /** Regressions that could not be traced to a single Change (must stay 0). */
  attributionFailures: number;
}

export function initialTrainState(config: z.input<typeof TrainConfig> = {}): TrainState {
  return {
    config: TrainConfig.parse(config),
    seq: 0,
    workers: {},
    trains: {},
    attributionFailures: 0,
  };
}

export const TrainEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ChangeMerged"),
    changeId: ChangeId,
    sha: z.string(),
    deploysTo: z.array(z.string()),
    flagKey: z.string().nullable(),
    files: z.array(z.string()),
    modules: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("TrainDeployed"), trainId: z.string(), versionId: z.string() }),
  z.object({ type: z.literal("TrainDeployFailed"), trainId: z.string(), message: z.string() }),
  z.object({
    type: z.literal("IssueReported"),
    worker: z.string(),
    versionId: z.string(),
    issueId: z.string(),
    frames: z.array(z.object({ file: z.string(), fn: z.string().optional() })).max(200),
  }),
  z.object({ type: z.literal("RegressionCleared"), trainId: z.string(), issueId: z.string() }),
  z.object({ type: z.literal("ErrorBudgetCleared"), trainId: z.string() }),
  z.object({ type: z.literal("RollbackDone"), trainId: z.string() }),
  z.object({ type: z.literal("Tick") }),
]);
export type TrainEvent = z.infer<typeof TrainEvent>;
export type TrainEventInput = z.input<typeof TrainEvent>;

export const TrainCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("StartDeployTrain"),
    trainId: z.string(),
    worker: z.string(),
    changes: z.array(
      z.object({ changeId: ChangeId, sha: z.string(), flagKey: z.string().nullable() }),
    ),
  }),
  z.object({
    type: z.literal("KillFlag"),
    trainId: z.string(),
    worker: z.string(),
    changeId: ChangeId,
    flagKey: z.string(),
    issueId: z.string(),
  }),
  z.object({
    type: z.literal("RollbackTrain"),
    trainId: z.string(),
    worker: z.string(),
    versionId: z.string().nullable(),
  }),
  /** Open an automatic revert Change (the merge queue freezes until it lands). */
  z.object({
    type: z.literal("RequestRevert"),
    changeId: ChangeId,
    issueId: z.string(),
    reason: z.string(),
  }),
  z.object({ type: z.literal("Emit"), event: QueueEvent }),
  z.object({
    type: z.literal("Audit"),
    action: z.string(),
    subject: z.string(),
    principalId: z.string(),
    signature: z.null(),
    payload: z.record(z.string(), z.unknown()),
  }),
]);
export type TrainCommand = z.infer<typeof TrainCommand>;

const SYSTEM = "system:deploy-trains";

function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * Attribution score of one Change for a set of stack frames: 3 per frame in a file the Change
 * touched, 1 per frame in a directory it touched. Transparent and logged with the decision.
 */
export function attributionScore(
  c: Pick<PendingDeploy, "files">,
  frames: { file: string }[],
): number {
  const files = new Set(c.files);
  const dirs = new Set(c.files.map(dir));
  let s = 0;
  for (const f of frames) {
    if (files.has(f.file)) s += 3;
    else if (dirs.has(dir(f.file))) s += 1;
  }
  return s;
}

export function trainStep(
  state: TrainState,
  event: TrainEvent,
  ctx: { now: number },
): { state: TrainState; commands: TrainCommand[] } {
  const s: TrainState = {
    ...state,
    workers: Object.fromEntries(
      Object.entries(state.workers).map(([k, w]) => [
        k,
        { pending: [...w.pending], active: w.active, history: [...w.history] },
      ]),
    ),
    trains: Object.fromEntries(Object.entries(state.trains).map(([k, t]) => [k, { ...t }])),
  };
  const out: TrainCommand[] = [];
  const now = ctx.now;
  const audit = (action: string, subject: string, payload: Record<string, unknown>): void => {
    out.push({ type: "Audit", action, subject, principalId: SYSTEM, signature: null, payload });
  };
  const worker = (name: string) => {
    let w = s.workers[name];
    if (w === undefined) {
      w = { pending: [], active: null, history: [] };
      s.workers[name] = w;
    }
    return w;
  };
  const finish = (t: Train, st: "released" | "rolled-back" | "failed"): void => {
    t.state = st;
    const w = worker(t.worker);
    if (w.active === t.id) w.active = null;
    w.history = [...w.history, t.id].slice(-s.config.historyLimit);
  };

  switch (event.type) {
    case "ChangeMerged": {
      for (const name of event.deploysTo)
        worker(name).pending.push({
          changeId: event.changeId,
          sha: event.sha,
          flagKey: event.flagKey,
          files: event.files,
          modules: event.modules,
          mergedAt: now,
        });
      break;
    }
    case "TrainDeployed": {
      const t = s.trains[event.trainId];
      if (t === undefined || t.state !== "deploying") break;
      t.state = "watching";
      t.versionId = event.versionId;
      t.deployedAt = now;
      t.watchUntil = now + s.config.watchMs;
      out.push({
        type: "Emit",
        event: {
          type: "deployed",
          at: now,
          trainId: t.id,
          worker: t.worker,
          versionId: event.versionId,
          changeIds: t.changes.map((c) => c.changeId),
        },
      });
      audit("deploy.train-deployed", `train:${t.id}`, {
        worker: t.worker,
        versionId: event.versionId,
        changes: t.changes.map((c) => c.changeId),
      });
      break;
    }
    case "TrainDeployFailed": {
      const t = s.trains[event.trainId];
      if (t === undefined || t.state !== "deploying") break;
      audit("deploy.train-failed", `train:${t.id}`, { message: event.message });
      const w = worker(t.worker);
      w.pending = [...t.changes, ...w.pending];
      finish(t, "failed");
      break;
    }
    case "IssueReported": {
      const w = worker(event.worker);
      const t = [w.active, ...[...w.history].reverse()]
        .map((id) => (id === null ? undefined : s.trains[id]))
        .find((x) => x !== undefined && x.versionId === event.versionId);
      if (t === undefined) {
        s.attributionFailures++;
        audit("deploy.regression-unattributed", `worker:${event.worker}`, {
          issueId: event.issueId,
          versionId: event.versionId,
          why: "no train deployed this version",
        });
        break;
      }
      if (t.state === "rolling-back" || t.state === "rolled-back") break;
      if (t.state === "killing") break; // one regression at a time; re-evaluated once it settles
      const candidates = t.changes.filter((c) => !t.killed.includes(c.changeId));
      if (candidates.length === 0) break;
      const scores: Record<string, number> = {};
      for (const c of candidates) scores[c.changeId] = attributionScore(c, event.frames);
      // Highest score; ties → the most recently merged (it is the least proven in production).
      const ranked = [...candidates].sort(
        (a, b) => (scores[b.changeId] ?? 0) - (scores[a.changeId] ?? 0) || b.mergedAt - a.mergedAt,
      );
      const suspect = ranked[0];
      if (suspect === undefined) break;
      if (candidates.length === 1 || suspect.flagKey === null) {
        // Deployed alone (or not switchable): the version identifies the Change exactly.
        t.attributions = [
          ...t.attributions,
          {
            issueId: event.issueId,
            changeId: suspect.changeId,
            scores,
            method: candidates.length === 1 ? "single-change-train" : "rollback",
            confirmed: candidates.length === 1 ? true : null,
            at: now,
          },
        ];
        if (suspect.flagKey !== null && candidates.length === 1) {
          t.state = "killing";
          t.regression = {
            issueId: event.issueId,
            suspect: suspect.changeId,
            deadline: now + s.config.killWatchMs,
          };
          out.push({
            type: "KillFlag",
            trainId: t.id,
            worker: t.worker,
            changeId: suspect.changeId,
            flagKey: suspect.flagKey,
            issueId: event.issueId,
          });
          out.push({
            type: "Emit",
            event: {
              type: "flag_killed",
              at: now,
              trainId: t.id,
              worker: t.worker,
              changeId: suspect.changeId,
              flagKey: suspect.flagKey,
              issueId: event.issueId,
            },
          });
        } else {
          t.state = "rolling-back";
          out.push({
            type: "RollbackTrain",
            trainId: t.id,
            worker: t.worker,
            versionId: t.versionId,
          });
          out.push({
            type: "RequestRevert",
            changeId: suspect.changeId,
            issueId: event.issueId,
            reason: `regression ${event.issueId} in ${t.worker} version ${event.versionId}`,
          });
        }
        audit("deploy.regression-attributed", `change:${suspect.changeId}`, {
          trainId: t.id,
          issueId: event.issueId,
          scores,
          method: t.attributions[t.attributions.length - 1]?.method,
        });
        break;
      }
      t.state = "killing";
      t.regression = {
        issueId: event.issueId,
        suspect: suspect.changeId,
        deadline: now + s.config.killWatchMs,
      };
      t.attributions = [
        ...t.attributions,
        {
          issueId: event.issueId,
          changeId: suspect.changeId,
          scores,
          method: "flag-kill",
          confirmed: null,
          at: now,
        },
      ];
      out.push({
        type: "KillFlag",
        trainId: t.id,
        worker: t.worker,
        changeId: suspect.changeId,
        flagKey: suspect.flagKey,
        issueId: event.issueId,
      });
      out.push({
        type: "Emit",
        event: {
          type: "flag_killed",
          at: now,
          trainId: t.id,
          worker: t.worker,
          changeId: suspect.changeId,
          flagKey: suspect.flagKey,
          issueId: event.issueId,
        },
      });
      audit("deploy.flag-killed", `change:${suspect.changeId}`, {
        trainId: t.id,
        issueId: event.issueId,
        scores,
      });
      break;
    }
    case "RegressionCleared": {
      const t = s.trains[event.trainId];
      if (t === undefined || t.state !== "killing" || t.regression?.issueId !== event.issueId)
        break;
      const suspect = t.regression.suspect;
      t.killed = [...t.killed, suspect];
      t.attributions = t.attributions.map((a) =>
        a.issueId === event.issueId ? { ...a, confirmed: true } : a,
      );
      t.regression = null;
      t.state = "watching";
      out.push({
        type: "RequestRevert",
        changeId: suspect,
        issueId: event.issueId,
        reason: `flag killed after regression ${event.issueId}; reverting`,
      });
      audit("deploy.regression-attributed", `change:${suspect}`, {
        trainId: t.id,
        issueId: event.issueId,
        confirmed: true,
      });
      break;
    }
    case "ErrorBudgetCleared": {
      const t = s.trains[event.trainId];
      if (t === undefined || t.state !== "watching") break;
      finish(t, "released");
      audit("deploy.train-released", `train:${t.id}`, { early: true });
      break;
    }
    case "RollbackDone": {
      const t = s.trains[event.trainId];
      if (t === undefined || t.state !== "rolling-back") break;
      finish(t, "rolled-back");
      audit("deploy.train-rolled-back", `train:${t.id}`, {});
      break;
    }
    case "Tick": {
      for (const t of Object.values(s.trains)) {
        if (t.state === "watching" && t.watchUntil !== null && now >= t.watchUntil) {
          finish(t, "released");
          audit("deploy.train-released", `train:${t.id}`, { early: false });
        } else if (t.state === "killing" && t.regression !== null && now >= t.regression.deadline) {
          // The killed flag didn't clear it: roll the whole train back.
          s.attributionFailures++;
          const issueId = t.regression.issueId;
          t.attributions = t.attributions.map((a) =>
            a.issueId === issueId ? { ...a, confirmed: false } : a,
          );
          t.regression = null;
          t.state = "rolling-back";
          out.push({
            type: "RollbackTrain",
            trainId: t.id,
            worker: t.worker,
            versionId: t.versionId,
          });
          audit("deploy.regression-unattributed", `train:${t.id}`, {
            issueId,
            why: "killing the most likely flag did not clear it; rolling back the train",
          });
        }
      }
      break;
    }
  }

  // Start the next train on every idle Worker.
  for (const [name, w] of Object.entries(s.workers)) {
    if (w.active !== null || w.pending.length === 0) continue;
    const first = w.pending[0];
    if (first === undefined) continue;
    const changes: PendingDeploy[] = [first];
    if (first.flagKey !== null) {
      const files = new Set(first.files);
      for (const c of w.pending.slice(1)) {
        if (c.flagKey === null || changes.length >= s.config.maxTrainSize) break;
        if (c.files.some((f) => files.has(f))) break; // keep stack frames unambiguous
        changes.push(c);
        for (const f of c.files) files.add(f);
      }
    }
    w.pending = w.pending.slice(changes.length);
    const id = `t${(++s.seq).toString(36)}`;
    s.trains[id] = {
      id,
      worker: name,
      changes,
      state: "deploying",
      versionId: null,
      deployedAt: null,
      watchUntil: null,
      killed: [],
      regression: null,
      attributions: [],
    };
    w.active = id;
    out.push({
      type: "StartDeployTrain",
      trainId: id,
      worker: name,
      changes: changes.map((c) => ({ changeId: c.changeId, sha: c.sha, flagKey: c.flagKey })),
    });
  }
  // Forget old trains.
  const keep = new Set<string>();
  for (const w of Object.values(s.workers)) {
    if (w.active !== null) keep.add(w.active);
    for (const h of w.history) keep.add(h);
  }
  for (const id of Object.keys(s.trains)) if (!keep.has(id)) delete s.trains[id];
  return { state: s, commands: out };
}
