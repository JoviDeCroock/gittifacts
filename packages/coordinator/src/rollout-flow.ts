/**
 * The RolloutWorkflow body (docs/architecture.md, Rollout). One instance per merged change, id
 * `rollout-<changeId>`:
 *
 *  load → slot-* (one rollout per script at a time) → flag → upload →
 *  for each stage: stage-i (split) → [wait (issue | 1 min) → check]* until stageMinutes elapsed →
 *  watch → [wait → check]* until watchMinutes elapsed → released
 *  on regression: regression → flag-off → rollback → revert
 *
 * Waits are `waitForEvent("issue", 1 minute)`: a sleep that a Workers Issues webhook cuts short,
 * so detection does not wait for the next poll. RolloutState is recorded on the change throughout.
 */
import type { RolloutPolicy, RolloutState } from "@app/domain";
import type { FlowDeps } from "./change-flow.js";
import { EVENT_ISSUE, RolloutParams } from "./events.js";
import { evaluateHealth, type HealthSample, type HealthVerdict } from "./health.js";
import { changeSubject } from "./ids.js";
import { errorMessage } from "./policy.js";
import { SYSTEM_PRINCIPAL_ID } from "./ports.js";
import { openRevertChange } from "./revert.js";
import { RETRY, type Step, waitOrTimeout } from "./step.js";
import { withChangeNotifications } from "./milestones.js";

export type RolloutOutcome = "skipped" | "released" | "rolled-back";

export interface RolloutOutput {
  outcome: RolloutOutcome;
  versionId: string | null;
  revertChangeId: string | null;
  reasons: string[];
}

export const CHECK_INTERVAL = "1 minute";
const CHECK_INTERVAL_MS = 60_000;
/** Waiting for another rollout on the same script to finish: up to 2 hours. */
const SLOT_ROUNDS = 120;

interface Loaded {
  skip: string | null;
  script: string;
  mergedSha: string;
  title: string;
  repoId: string;
  flagKey: string | null;
}

export async function runRollout(deps: FlowDeps, rawParams: RolloutParams, step: Step): Promise<RolloutOutput> {
  const ports = withChangeNotifications(deps.ports, deps.bindings);
  const { store, audit, notifier, clock, deployer, flags, telemetry } = ports;
  const params = RolloutParams.parse(rawParams);
  const { changeId } = params;
  const policy: RolloutPolicy = params.rollout;
  const subject = changeSubject(changeId);
  const log = (action: string, payload: unknown) =>
    audit.append({ principalId: SYSTEM_PRINCIPAL_ID, action, subject, payload });
  const patchState = async (patch: Partial<RolloutState>): Promise<RolloutState> => {
    const change = await store.getChange(changeId);
    const current: RolloutState = change?.rolloutState ?? {
      status: "pending",
      versionId: null,
      previousVersionId: null,
      stages: policy.stages.map((percent) => ({ percent, startedAt: null, completedAt: null })),
      watchUntil: null,
      flagKey: null,
      lastCheck: null,
    };
    const next = { ...current, ...patch };
    await store.updateChange(changeId, { rolloutState: next });
    return next;
  };

  // ------------------------------------------------------------ load
  const ctx = await step.do("load", RETRY.quick, async (): Promise<Loaded> => {
    const change = await store.getChange(changeId);
    const none = { script: "", mergedSha: "", title: "", repoId: "", flagKey: null };
    if (change === null || change.mergedSha === null) return { ...none, skip: "change is not merged" };
    if (change.status !== "rolling-out" && change.status !== "merged") return { ...none, skip: `change is ${change.status}` };
    const repo = await store.getRepo(change.repoId);
    if (repo?.deployTarget == null) return { ...none, skip: "repo has no deploy target" };
    if (repo.claim.status !== "claimed") {
      await log("rollout.skipped", { reason: "unclaimed project (previews only)" });
      return { ...none, skip: "unclaimed project" };
    }
    if (params.bundleRef === null) {
      await store.updateChange(changeId, { status: "merged", rolloutState: null });
      await log("rollout.skipped", { reason: "no bundle for the merged sha" });
      return { ...none, skip: "no bundle" };
    }
    if (change.status === "merged") await store.updateChange(changeId, { status: "rolling-out" });
    return { skip: null, script: repo.deployTarget, mergedSha: change.mergedSha, title: change.title, repoId: repo.id, flagKey: change.flagKey };
  });
  if (ctx.skip !== null) return { outcome: "skipped", versionId: null, revertChangeId: null, reasons: [ctx.skip] };
  const { script } = ctx;
  const bundleRef = params.bundleRef ?? "";

  // ------------------------------------------------------------ one rollout per script at a time
  let previousVersionId: string | null = null;
  for (let round = 1; ; round++) {
    const slot = await step.do(`slot-${round}`, RETRY.remote, async () => {
      const versions = await deployer.currentVersions(script);
      const live = versions.filter((v) => v.percentage > 0);
      if (live.length <= 1) return { free: true, previous: live[0]?.versionId ?? null };
      return { free: false, previous: null };
    });
    if (slot.free) {
      previousVersionId = slot.previous;
      break;
    }
    if (round >= SLOT_ROUNDS) {
      // Never deploy over someone else's split: give up visibly instead.
      await step.do("slot-timeout", RETRY.quick, async () => {
        await patchState({ status: "failed" });
        await log("rollout.blocked", { reason: "another rollout kept the script split for 2 hours" });
        await notifier.notify({ kind: "rollout-stage", changeId, repoId: ctx.repoId, message: `Rollout of ${ctx.title} blocked: ${script} is mid-rollout.` });
        return true;
      });
      return { outcome: "skipped", versionId: null, revertChangeId: null, reasons: ["deployment slot busy"] };
    }
    await step.sleep(`slot-wait-${round}`, CHECK_INTERVAL);
  }

  // Without a previous version there is nothing to split against (or roll back to): go to 100%.
  const stages = previousVersionId === null ? [100] : policy.stages;

  // ------------------------------------------------------------ 1. flag
  const flagKey = await step.do("flag", RETRY.remote, async () => {
    const key = await flags.ensureChangeFlag(changeId, { enabled: true, description: `change ${changeId}: ${ctx.title}`.slice(0, 500) });
    await store.updateChange(changeId, { flagKey: key });
    await patchState({ flagKey: key });
    await log("rollout.flag-ready", { flagKey: key });
    return key;
  });

  // ------------------------------------------------------------ 2. upload
  const versionId = await step.do("upload", RETRY.once, async () => {
    const { versionId: id } = await deployer.uploadVersion({
      script,
      changeId,
      sha: ctx.mergedSha,
      bundleRef,
      message: `change ${changeId}: ${ctx.title}`.slice(0, 1000),
    });
    await patchState({
      status: "rolling",
      versionId: id,
      previousVersionId,
      stages: stages.map((percent) => ({ percent, startedAt: null, completedAt: null })),
    });
    await log("rollout.version-uploaded", { versionId: id, previousVersionId, bundleRef });
    return id;
  });

  // ------------------------------------------------------------ checks
  const samples: HealthSample[] = [];
  let checks = 0;
  const checkOnce = async (label: string, since: string): Promise<HealthVerdict> => {
    checks++;
    const sample = await step.do(`${label}-check-${checks}`, RETRY.quick, async (): Promise<HealthSample> => {
      const at = clock.now().toISOString();
      let s: HealthSample;
      try {
        const r = await telemetry.check({ script, versionId, baselineVersionId: previousVersionId, since });
        s = { ok: true, at, requests: r.requests, errorRate: r.errorRate, baselineErrorRate: r.baselineErrorRate, newIssueGroups: r.newIssueGroups };
        await patchState({
          lastCheck: { at, errorRate: r.errorRate, baselineErrorRate: r.baselineErrorRate, requests: Math.trunc(r.requests), newIssueGroups: Math.trunc(r.newIssueGroups) },
        });
      } catch (e) {
        s = { ok: false, at, error: errorMessage(e) };
      }
      return s;
    });
    samples.push(sample);
    return evaluateHealth(policy, samples);
  };

  /** Watch until `minutes` have elapsed since `since` (by step-recorded time). */
  const watchFor = async (label: string, since: string, minutes: number): Promise<HealthVerdict | null> => {
    const until = Date.parse(since) + minutes * CHECK_INTERVAL_MS;
    let waits = 0;
    // Bounded even if issue events arrive in a flood.
    while (waits < minutes * 3) {
      waits++;
      await waitOrTimeout(step, `${label}-wait-${waits}`, EVENT_ISSUE, CHECK_INTERVAL);
      const verdict = await checkOnce(label, since);
      if (verdict.status === "regression") return verdict;
      const last = samples[samples.length - 1];
      if (last !== undefined && Date.parse(last.at) >= until) return null;
    }
    return null;
  };

  // ------------------------------------------------------------ 3. stages
  let regression: HealthVerdict | null = null;
  for (let i = 0; i < stages.length && regression === null; i++) {
    const percent = stages[i] ?? 100;
    const since = await step.do(`stage-${i + 1}`, RETRY.remote, async () => {
      const split =
        percent >= 100 || previousVersionId === null
          ? [{ versionId, percentage: 100 }]
          : [
              { versionId, percentage: percent },
              { versionId: previousVersionId, percentage: 100 - percent },
            ];
      await deployer.setSplit(script, split, `change ${changeId}: ${percent}%`);
      const at = clock.now().toISOString();
      const change = await store.getChange(changeId);
      const stagesState = (change?.rolloutState?.stages ?? []).map((s, j) =>
        j === i ? { ...s, startedAt: at } : j === i - 1 && s.completedAt === null ? { ...s, completedAt: at } : s,
      );
      await patchState({ status: "rolling", stages: stagesState });
      await notifier.notify({ kind: "rollout-stage", changeId, repoId: ctx.repoId, message: `${ctx.title}: ${percent}% of traffic on ${versionId}.` });
      await log("rollout.stage", { stage: i + 1, percent, split });
      return at;
    });
    regression = await watchFor(`stage-${i + 1}`, since, policy.stageMinutes);
  }

  // ------------------------------------------------------------ 4. watch window at 100%
  if (regression === null) {
    const since = await step.do("watch", RETRY.quick, async () => {
      const at = clock.now();
      const change = await store.getChange(changeId);
      const stagesState = (change?.rolloutState?.stages ?? []).map((s) => (s.completedAt === null ? { ...s, completedAt: at.toISOString() } : s));
      await patchState({ status: "watching", stages: stagesState, watchUntil: new Date(at.getTime() + policy.watchMinutes * CHECK_INTERVAL_MS).toISOString() });
      await log("rollout.watching", { minutes: policy.watchMinutes });
      return at.toISOString();
    });
    regression = await watchFor("watch", since, policy.watchMinutes);
  }

  if (regression === null) {
    const verdict = evaluateHealth(policy, samples);
    await step.do("released", RETRY.quick, async () => {
      await patchState({ status: "released" });
      await store.updateChange(changeId, { status: "released" });
      await log("rollout.released", { versionId, checks, verdict });
      await notifier.notify({ kind: "rollout-stage", changeId, repoId: ctx.repoId, message: `${ctx.title} is released (${verdict.reasons.join("; ")}).` });
      return true;
    });
    return { outcome: "released", versionId, revertChangeId: null, reasons: verdict.reasons };
  }

  // ------------------------------------------------------------ 5. regression → flag off → rollback → revert
  const reasons = regression.reasons;
  await step.do("regression", RETRY.quick, async () => {
    await patchState({ status: "rolling-back" });
    await log("rollout.regression", { versionId, reasons, sample: samples[samples.length - 1] ?? null });
    await notifier.notify({ kind: "regression-detected", changeId, repoId: ctx.repoId, message: `${ctx.title}: ${reasons.join("; ")}. Rolling back.` });
    return true;
  });
  await step.do("flag-off", RETRY.remote, async () => {
    await flags.setEnabled(flagKey, false);
    await log("rollout.flag-off", { flagKey });
    return true;
  });
  await step.do("rollback", RETRY.remote, async () => {
    if (previousVersionId === null) {
      await log("rollout.rollback-impossible", { reason: "no previous version; the flag is the only mitigation" });
      return false;
    }
    await deployer.rollback(script, previousVersionId, `auto-revert change ${changeId}: ${reasons.join("; ")}`.slice(0, 1000));
    await patchState({ status: "rolled-back" });
    await log("rollout.rolled-back", { to: previousVersionId });
    return true;
  });
  const revertChangeId = await step.do("revert", RETRY.remote, async () => {
    const original = await store.getChange(changeId);
    if (original === null) throw new Error("change disappeared");
    const result = await openRevertChange({ ports, bindings: deps.bindings }, { original, reason: `rollout regression: ${reasons.join("; ")}` });
    await store.updateChange(changeId, { status: "reverted", revertedBy: result.change.id });
    if (previousVersionId === null) await patchState({ status: "failed" });
    await notifier.notify({ kind: "reverted", changeId, repoId: ctx.repoId, message: `${ctx.title} was rolled back; revert change ${result.change.id} (${result.method}).` });
    await log("rollout.reverted", { revertChangeId: result.change.id, method: result.method });
    return result.change.id;
  });
  return { outcome: "rolled-back", versionId, revertChangeId, reasons };
}
