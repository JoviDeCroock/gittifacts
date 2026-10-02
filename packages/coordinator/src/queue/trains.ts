/**
 * `TrainShell` (packages/merge-queue/src/trains.ts) on the coordinator's release ports, reusing
 * the RolloutWorkflow's pieces instead of a second rollout implementation: Flagship kill-switch
 * flags (`Flags`), gradual deployments (`Deployer.uploadVersion/setSplit/rollback`), health
 * (`Telemetry.check` + the pure `evaluateHealth`) and automatic reverts (`openRevertChange`).
 *
 * The pure `trainStep` decides (one train per Worker at a time, attribution, kill the most likely
 * flag first, escalate to rolling the whole train back). This shell executes, and the DO alarm
 * (`monitor`) advances the traffic stages, samples health, and turns a regression into
 * `IssueReported` (no stack frames: ties go to the most recently merged Change) or, after a
 * killed flag, into `RegressionCleared`.
 */
import type { RolloutPolicy } from "@app/domain";
import type { TrainCommand, TrainEventInput, TrainState } from "@app/merge-queue";
import { evaluateHealth, type HealthSample } from "../health.js";
import { changeSubject } from "../ids.js";
import { errorMessage } from "../policy.js";
import { openRevertChange } from "../revert.js";
import { shaKey } from "./cas.js";
import type { QueueContext, QueueIntent } from "./context.js";
import { onQueueEvent } from "./emit.js";

type TrainEmit = (event: TrainEventInput) => Promise<void>;

/** Shell-side progress of a deployed train (traffic stages, health samples). */
export interface TrainProgress {
  trainId: string;
  worker: string;
  versionId: string;
  previousVersionId: string | null;
  changeIds: string[];
  stages: number[];
  stageIndex: number;
  stageSince: number;
  samples: HealthSample[];
  /** The regression being handled (IssueReported sent; null when healthy). */
  regression: { issueId: string; at: number; samplesAfterKill: HealthSample[] } | null;
  regressions: number;
}

const progressKey = (trainId: string) => `train:${trainId}`;

export class CoordinatorTrainShell {
  constructor(private readonly ctx: QueueContext) {}

  private policy(): Promise<RolloutPolicy> {
    return this.ctx.repo().then((r) => r.policy.rollout);
  }

  dispatch(cmd: TrainCommand, emit: TrainEmit): Promise<void> {
    switch (cmd.type) {
      case "StartDeployTrain":
        return this.startDeployTrain(cmd, emit);
      case "KillFlag":
        return this.killFlag(cmd);
      case "RollbackTrain":
        return this.rollbackTrain(cmd, emit);
      case "RequestRevert":
        return this.requestRevert(cmd);
      case "Emit":
        return this.onEmit(cmd.event);
      case "Audit":
        return this.onAudit(cmd);
    }
  }

  private progress(trainId: string): TrainProgress | null {
    return this.ctx.deps.store.getRun<TrainProgress>(progressKey(trainId));
  }

  private save(p: TrainProgress): void {
    this.ctx.deps.store.putRun(progressKey(p.trainId), p);
  }

  async startDeployTrain(
    cmd: Extract<TrainCommand, { type: "StartDeployTrain" }>,
    emit: TrainEmit,
  ): Promise<void> {
    const { deployer, flags, store } = this.ctx.ports;
    const done = this.progress(cmd.trainId);
    if (done !== null)
      return emit({ type: "TrainDeployed", trainId: cmd.trainId, versionId: done.versionId });
    // Merge order: the last Change's merged commit contains every earlier one.
    const last = cmd.changes[cmd.changes.length - 1];
    const bundleRef =
      last === undefined
        ? null
        : (this.ctx.deps.store.getRun<{ bundleRef: string | null }>(shaKey(last.sha))?.bundleRef ??
          null);
    if (last === undefined || bundleRef === null)
      return emit({
        type: "TrainDeployFailed",
        trainId: cmd.trainId,
        message: "no bundle for the train's merged commit",
      });
    for (const c of cmd.changes) {
      if (c.flagKey === null) continue;
      await flags.ensureChangeFlag(c.changeId, {
        enabled: true,
        description: `change ${c.changeId} (train ${cmd.trainId})`,
      });
    }
    const live = (await deployer.currentVersions(cmd.worker)).filter((v) => v.percentage > 0);
    const previous = live.sort((a, b) => b.percentage - a.percentage)[0]?.versionId ?? null;
    const { versionId } = await deployer.uploadVersion({
      script: cmd.worker,
      changeId: last.changeId,
      sha: last.sha,
      bundleRef,
      message: `train ${cmd.trainId}: ${cmd.changes.map((c) => c.changeId).join(", ")}`.slice(
        0,
        1000,
      ),
    });
    const policy = await this.policy();
    const stages = previous === null ? [100] : policy.stages;
    await this.split(cmd.worker, versionId, previous, stages[0] ?? 100, cmd.trainId);
    const now = this.ctx.now();
    this.save({
      trainId: cmd.trainId,
      worker: cmd.worker,
      versionId,
      previousVersionId: previous,
      changeIds: cmd.changes.map((c) => c.changeId),
      stages,
      stageIndex: 0,
      stageSince: now,
      samples: [],
      regression: null,
      regressions: 0,
    });
    for (const c of cmd.changes) {
      const change = await store.getChange(c.changeId);
      if (change === null) continue;
      await store.updateChange(c.changeId, {
        status: change.status === "merged" ? "rolling-out" : change.status,
        ...(c.flagKey === null ? {} : { flagKey: c.flagKey }),
        rolloutState: {
          status: "rolling",
          versionId,
          previousVersionId: previous,
          stages: stages.map((percent, i) => ({
            percent,
            startedAt: i === 0 ? new Date(now).toISOString() : null,
            completedAt: null,
          })),
          watchUntil: null,
          flagKey: c.flagKey,
          lastCheck: null,
        },
      });
    }
    await emit({ type: "TrainDeployed", trainId: cmd.trainId, versionId });
  }

  private async split(
    worker: string,
    versionId: string,
    previous: string | null,
    percent: number,
    trainId: string,
  ) {
    const split =
      percent >= 100 || previous === null
        ? [{ versionId, percentage: 100 }]
        : [
            { versionId, percentage: percent },
            { versionId: previous, percentage: 100 - percent },
          ];
    await this.ctx.ports.deployer.setSplit(worker, split, `train ${trainId}: ${percent}%`);
  }

  async killFlag(cmd: Extract<TrainCommand, { type: "KillFlag" }>): Promise<void> {
    await this.ctx.ports.flags.setEnabled(cmd.flagKey, false);
    const p = this.progress(cmd.trainId);
    if (p !== null)
      this.save({
        ...p,
        samples: [],
        regression: { issueId: cmd.issueId, at: this.ctx.now(), samplesAfterKill: [] },
      });
    await this.ctx.audit(changeSubject(cmd.changeId), "deploy.flag-off", {
      trainId: cmd.trainId,
      flagKey: cmd.flagKey,
      issueId: cmd.issueId,
    });
  }

  async rollbackTrain(
    cmd: Extract<TrainCommand, { type: "RollbackTrain" }>,
    emit: TrainEmit,
  ): Promise<void> {
    const p = this.progress(cmd.trainId);
    const to = p?.previousVersionId ?? null;
    if (to !== null)
      await this.ctx.ports.deployer.rollback(cmd.worker, to, `train ${cmd.trainId} rolled back`);
    else
      await this.ctx.audit(this.ctx.repoSubject(), "deploy.rollback-impossible", {
        trainId: cmd.trainId,
        reason: "no previous version; the flags are the only mitigation",
      });
    for (const id of p?.changeIds ?? []) await this.setRollout(id, "rolled-back");
    await emit({ type: "RollbackDone", trainId: cmd.trainId });
  }

  /** The pure inverse of the attributed Change, enqueued as an automatic revert (freezes the queue). */
  async requestRevert(cmd: Extract<TrainCommand, { type: "RequestRevert" }>): Promise<void> {
    const { store, notifier } = this.ctx.ports;
    const original = await store.getChange(cmd.changeId);
    if (original === null || original.mergedSha === null) return;
    const result = await openRevertChange(
      { ports: this.ctx.ports, bindings: this.ctx.deps.bindings },
      { original, reason: cmd.reason },
    );
    const intent: QueueIntent = {
      workflowInstanceId: null,
      ...(this.ctx.intent(result.change.id) ?? {}),
      options: { priority: "revert", automaticRevert: true },
      requestedBy: { principalId: "system:deploy-trains", kind: "system", sessionId: null },
      admittedHead: null,
      title: result.change.title,
      updatedAt: this.ctx.now(),
    };
    this.ctx.deps.store.putIntent(result.change.id, intent);
    await store.updateChange(original.id, { status: "reverted", revertedBy: result.change.id });
    await notifier.notify({
      kind: "reverted",
      changeId: original.id,
      repoId: original.repoId,
      message: `${original.title} is being reverted (${cmd.reason}); revert change ${result.change.id}.`,
    });
  }

  private async onEmit(event: Extract<TrainCommand, { type: "Emit" }>["event"]): Promise<void> {
    await onQueueEvent(this.ctx, event);
  }

  private async onAudit(cmd: Extract<TrainCommand, { type: "Audit" }>): Promise<void> {
    await this.ctx.ports.audit.append({
      principalId: cmd.principalId,
      action: cmd.action,
      subject: cmd.subject,
      payload: { ...cmd.payload, repoId: this.ctx.repoId },
    });
    const trainId = cmd.subject.startsWith("train:") ? cmd.subject.slice(6) : null;
    if (trainId === null) return;
    const p = this.progress(trainId);
    if (cmd.action === "deploy.train-released" && p !== null)
      for (const id of p.changeIds) await this.setRollout(id, "released");
  }

  private async setRollout(changeId: string, status: "released" | "rolled-back"): Promise<void> {
    const { store } = this.ctx.ports;
    const change = await store.getChange(changeId);
    if (change === null) return;
    const rollout = change.rolloutState === null ? null : { ...change.rolloutState, status };
    const next =
      status === "released" && change.status === "rolling-out"
        ? { status: "released" as const }
        : {};
    await store.updateChange(changeId, {
      ...next,
      ...(rollout === null ? {} : { rolloutState: rollout }),
    });
  }

  private async sample(p: TrainProgress, since: number): Promise<HealthSample> {
    const at = new Date(this.ctx.now()).toISOString();
    try {
      const r = await this.ctx.ports.telemetry.check({
        script: p.worker,
        versionId: p.versionId,
        baselineVersionId: p.previousVersionId,
        since: new Date(since).toISOString(),
      });
      return {
        ok: true,
        at,
        requests: r.requests,
        errorRate: r.errorRate,
        baselineErrorRate: r.baselineErrorRate,
        newIssueGroups: r.newIssueGroups,
      };
    } catch (e) {
      return { ok: false, at, error: errorMessage(e) };
    }
  }

  /**
   * DO alarm: for each train in its watch window, sample health; a regression becomes
   * `IssueReported` (the machine attributes it and kills the most likely flag first); a killed
   * flag whose regression is gone becomes `RegressionCleared`; healthy trains move to the next
   * traffic stage once `stageMinutes` passed. `dispatch` is the loop's (synchronous) train input.
   */
  async monitor(trains: TrainState, dispatch: (e: TrainEventInput) => void): Promise<void> {
    const active = Object.values(trains.trains).filter(
      (t) => t.state === "watching" || t.state === "killing",
    );
    if (active.length === 0) return;
    const policy = await this.policy();
    for (const t of active) {
      const p = this.progress(t.id);
      if (p === null) continue;
      const now = this.ctx.now();
      if (t.state === "killing") {
        if (p.regression === null) continue;
        const after = [
          ...p.regression.samplesAfterKill,
          await this.sample(p, p.regression.at),
        ].slice(-10);
        this.save({ ...p, regression: { ...p.regression, samplesAfterKill: after } });
        const verdict = evaluateHealth(policy, after);
        if (verdict.status !== "regression" && after.length >= 2)
          dispatch({ type: "RegressionCleared", trainId: t.id, issueId: p.regression.issueId });
        continue;
      }
      const samples = [...p.samples, await this.sample(p, p.stageSince)].slice(-30);
      if (evaluateHealth(policy, samples).status === "regression") {
        const issueId = `telemetry-${t.id}-${p.regressions + 1}`;
        this.save({ ...p, samples: [], regressions: p.regressions + 1 });
        dispatch({
          type: "IssueReported",
          worker: t.worker,
          versionId: p.versionId,
          issueId,
          frames: [],
        });
        continue;
      }
      if (
        p.stageIndex < p.stages.length - 1 &&
        now - p.stageSince >= policy.stageMinutes * 60_000
      ) {
        const i = p.stageIndex + 1;
        await this.split(t.worker, p.versionId, p.previousVersionId, p.stages[i] ?? 100, t.id);
        this.save({ ...p, samples: [], stageIndex: i, stageSince: now });
      } else this.save({ ...p, samples });
    }
  }
}
