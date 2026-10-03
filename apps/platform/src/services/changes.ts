import type { ClassifyResult } from "@app/classifier";
import type { GitRemoteGrant, RerunResult } from "@app/coordinator";
import {
  type Change,
  type ChangeDiff,
  type Evidence,
  type Lane,
  type LinkedIssue,
  type PipelineRun,
  type ReviewDecision,
  type RolloutPolicy,
  type RolloutState,
  StartChangeInput,
  type Tour,
} from "@app/domain";
import { stripAnsi } from "@app/evidence";
import type { z } from "zod";
import { assertChangeAccess, assertPlanAccess, assertRepoAccess } from "../access/access.js";
import type { ReviewBody } from "../api/schemas.js";
import type { Caller, Services } from "../app-env.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { admitUnclaimedWork } from "../limits/gates.js";
import type { ChangeSummary, PrincipalRef } from "../store/d1-store.js";
import type { PlanView } from "../store/rows.js";
import { type AuditEventView, withSummaries } from "./audit.js";
import { withLiveSteps } from "./live-runs.js";
import { planPrincipalIds } from "./plans.js";
import { type ResolutionView, resolutionOf } from "./resolution.js";

/** Statuses after which nobody needs to look at a change any more. */
const TERMINAL: readonly Change["status"][] = [
  "merged",
  "released",
  "reverted",
  "rejected",
  "abandoned",
];

export async function requireChange(svc: Services, changeId: string): Promise<Change> {
  const change = await svc.store.getChange(changeId);
  if (!change) {
    throw notFound(`change ${changeId}`, {
      explanation:
        "No change with that id. Start one from an approved plan (or list a repo's changes).",
      call: 'start_change({ repoId: "<repoId>", planId: "<planId>", title: "<title>", category: "fix" })',
    });
  }
  return change;
}

// ---------------------------------------------------------------- reads

export async function listChangeSummaries(
  svc: Services,
  caller: Caller,
  repoId: string,
  filter: { statuses?: Change["status"][] | undefined; lane?: Lane | undefined },
): Promise<{ changes: ChangeSummary[]; principals: Record<string, PrincipalRef> }> {
  await assertRepoAccess(svc, caller.principal, repoId, "read");
  const changes = await svc.store.listChangeSummaries(repoId, {
    ...(filter.statuses ? { statuses: filter.statuses } : {}),
    ...(filter.lane !== undefined ? { lane: filter.lane } : {}),
  });
  return { changes, principals: await svc.store.principalRefs(changes.map((c) => c.authorId)) };
}

/** Reason text is read by people; classifications stored before the classifier stripped tool colour codes may carry them. */
function withoutAnsi(c: ClassifyResult | null): ClassifyResult | null {
  if (c === null) return null;
  return {
    ...c,
    reasons: c.reasons.map((r) => ({ ...r, message: stripAnsi(r.message) })),
    checklist: c.checklist.map((g) => ({ ...g, detail: stripAnsi(g.detail) })),
  };
}

export interface ChangeDetail {
  change: Change;
  plan: PlanView | null;
  runs: PipelineRun[];
  classification: ClassifyResult | null;
  principals: Record<string, PrincipalRef>;
}

export async function getChangeDetail(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<ChangeDetail> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const [plan, runs, classification] = await Promise.all([
    change.planId ? svc.store.getPlanView(change.planId) : Promise.resolve(null),
    // Runs in flight get their steps live from the engine's records (D1 has them at the end).
    svc.store
      .listRuns(change.id)
      .then((stored) => withLiveSteps(svc.env.CI_BUCKET, stored, svc.clock.now().getTime())),
    change.headSha
      ? svc.store.getClassification(change.id, change.headSha).then(withoutAnsi)
      : Promise.resolve(null),
  ]);
  const principals = await svc.store.principalRefs([
    change.authorId,
    ...(plan ? planPrincipalIds([plan]) : []),
  ]);
  return { change, plan, runs, classification, principals };
}

export async function listChangeReviews(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<{ reviews: ReviewDecision[]; principals: Record<string, PrincipalRef> }> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const reviews = await svc.store.listReviews(change.id);
  return { reviews, principals: await svc.store.principalRefs(reviews.map((r) => r.reviewerId)) };
}

export async function requireRepo(svc: Services, repoId: string) {
  const repo = await svc.store.getRepo(repoId);
  if (!repo)
    throw notFound(`repo ${repoId}`, {
      explanation: "No repo with that id. List the repos you can act on.",
      call: "list_repos({})",
    });
  return repo;
}

function requireHead(change: Change): string {
  if (!change.headSha) {
    throw notFound(`nothing pushed yet for change ${change.id}`, {
      explanation: `Push your commits to the change's fork (branch ${change.forkName}); a fresh push token comes from refresh_push_token.`,
      call: `refresh_push_token({ changeId: "${change.id}" })`,
      command: "git push <remote.url> HEAD:<remote.branch>",
    });
  }
  return change.headSha;
}

function notReady(change: Change, what: string, head: string) {
  return notFound(`${what} for change ${change.id} at ${head}`, {
    explanation: `${what} is produced after CI runs for the pushed head; it is not there yet (status: ${change.status}). Check the status and try again when the pipeline has finished.`,
    call: `get_change_status({ changeId: "${change.id}" })`,
  });
}

export async function getChangeDiff(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<ChangeDiff> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const diff = await svc.store.getDiff(change.id, requireHead(change));
  if (!diff) throw notReady(change, "The diff", change.headSha ?? "");
  return diff;
}

export interface EvidenceWithVerification {
  evidence: Evidence;
  verification: { ok: boolean; keyId?: string; reason?: string };
}

/** Evidence for the current head, with the attestation re-verified against the platform keys. */
export async function getChangeEvidence(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<EvidenceWithVerification> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const head = requireHead(change);
  const [evidence, raw] = await Promise.all([
    svc.store.getEvidence(change.id, head),
    svc.store.getEvidenceRaw(change.id, head),
  ]);
  if (!evidence || raw === null) throw notReady(change, "Evidence", head);
  const signer = await svc.signer();
  // Verify the stored bytes as-is (schema parsing would strip injected fields).
  const r = await signer.verifyEvidenceDetailed(raw);
  let verification: EvidenceWithVerification["verification"] = r.ok
    ? { ok: true, keyId: r.keyId }
    : { ok: false, reason: r.reason };
  if (verification.ok && (evidence.changeId !== change.id || evidence.headSha !== head)) {
    verification = { ok: false, reason: "evidence is bound to a different change or head" };
  }
  return { evidence, verification };
}

/**
 * The change's latest tour. It is `stale` when it was generated for an older head than the one
 * the change is at now (a re-push happened and the new tour is not ready yet).
 */
export async function getChangeTour(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<{ tour: Tour; stale: boolean }> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const head = requireHead(change);
  const current = change.tourId ? await svc.store.getTourById(change.tourId) : null;
  // The merge queue's resolver rewrote the Change: the tour of the resolved head (it leads with
  // the resolution) describes what lands, so it wins over the pushed head's tour.
  if (current !== null && current.headSha !== head) {
    const resolution = await resolutionOf(svc, change);
    if (resolution?.headSha === current.headSha) return { tour: current, stale: false };
  }
  const tour =
    (await svc.store.getTour(change.id, head)) ??
    current ??
    (await svc.store.getLatestTour(change.id));
  if (!tour) throw notReady(change, "The tour", head);
  return { tour, stale: tour.headSha !== head };
}

/** The merge queue's resolution of this Change (null: it never needed one). */
export async function getChangeResolution(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<{ resolution: ResolutionView | null }> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  return { resolution: await resolutionOf(svc, change) };
}

export interface RolloutView {
  rollout: RolloutState | null;
  timeline: AuditEventView[];
  /** The rollout policy from the change's BASE (falls back to the repo's cached policy). */
  policy: RolloutPolicy;
  /** Default-branch sha the policy was read from. */
  policySha: string | null;
  principals: Record<string, PrincipalRef>;
}

export async function getChangeRollout(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<RolloutView> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const [events, repo, basePolicy] = await Promise.all([
    svc.store.auditTimeline(svc.auditLog, `change:${change.id}`),
    requireRepo(svc, change.repoId),
    svc.store.getRepoPolicyAt(change.repoId, change.baseSha),
  ]);
  const timeline = await withSummaries(svc, events);
  return {
    rollout: change.rolloutState,
    timeline,
    policy: (basePolicy ?? repo.policy).rollout,
    policySha: basePolicy ? change.baseSha : repo.policySha,
    principals: await svc.store.principalRefs(events.map((e) => e.principalId)),
  };
}

export async function listChangeIssues(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<LinkedIssue[]> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const versionId = change.rolloutState?.versionId ?? null;
  const [byChange, byVersion] = await Promise.all([
    svc.store.listIssues({ changeId: change.id }),
    versionId ? svc.store.listIssues({ versionId }) : Promise.resolve([]),
  ]);
  const seen = new Map<string, LinkedIssue>();
  for (const i of [...byChange, ...byVersion]) if (!seen.has(i.id)) seen.set(i.id, i);
  return [...seen.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

// ---------------------------------------------------------------- lifecycle (coordinator)

export async function startChange(
  svc: Services,
  caller: Caller,
  input: unknown,
  idempotencyKey?: string,
): Promise<{ change: Change; remote: GitRemoteGrant }> {
  const v = StartChangeInput.parse(input);
  // Repo access: the caller (an agent: its owning human) must be at least a reviewer.
  const repo = await assertRepoAccess(svc, caller.principal, v.repoId, "contribute");
  // O3: an unclaimed project pays a fork and a push token from its quotas.
  await admitUnclaimedWork(svc, repo, { ops: 2, what: "start_change" });
  if (v.planId !== undefined && !(await svc.store.getPlan(v.planId))) {
    throw notFound(`plan ${v.planId}`, {
      explanation:
        "A change implements a plan. Draft one, get a human to approve it, then start the change.",
      call: `create_plan({ repoId: "${v.repoId}", title: "<title>", intent: "<why>", acceptanceCriteria: ["<observable result>"] })`,
    });
  }
  // The plan must be one the caller can read (a plan of another repo is the coordinator's 400).
  if (v.planId !== undefined) await assertPlanAccess(svc, caller.principal, v.planId, "read");
  return svc.coordinator.startChange(caller.principal, {
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    repoId: v.repoId,
    title: v.title,
    category: v.category,
    ...(v.planId !== undefined ? { planId: v.planId } : {}),
    ...(v.summary !== undefined ? { summary: v.summary } : {}),
    ...(v.agentTraceId !== undefined ? { agentTraceId: v.agentTraceId } : {}),
  });
}

export async function refreshPushGrant(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<GitRemoteGrant> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "contribute");
  await admitUnclaimedWork(svc, await requireRepo(svc, change.repoId), {
    ops: 1,
    what: "refresh_push_token",
  });
  return svc.coordinator.refreshPushGrant(caller.principal, changeId);
}

export async function submitReview(
  svc: Services,
  caller: Caller,
  changeId: string,
  body: z.infer<typeof ReviewBody>,
  idempotencyKey?: string,
): Promise<Change> {
  if (caller.principal.kind !== "human") throw forbidden("only a human may review a change");
  // Members with reviewer or above only; nobody reviews an unclaimed project until it is claimed.
  await assertChangeAccess(svc, caller.principal, changeId, "review");
  return svc.coordinator.submitReview(caller.principal, changeId, {
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    decision: body.decision,
    ...(body.headSha !== undefined ? { headSha: body.headSha } : {}),
    ...(body.humanLane !== undefined ? { humanLane: body.humanLane } : {}),
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  });
}

export async function killChange(
  svc: Services,
  caller: Caller,
  changeId: string,
  reason: string,
): Promise<Change> {
  if (caller.principal.kind !== "human") throw forbidden("only a human may pull the kill switch");
  await assertChangeAccess(svc, caller.principal, changeId, "approve");
  return svc.coordinator.kill(caller.principal, changeId, reason);
}

/**
 * The author (or its owning human) asks for human attention: notify + audit. Never approves
 * anything; agents cannot approve.
 */
export async function requestReview(
  svc: Services,
  caller: Caller,
  changeId: string,
  message: string | undefined,
): Promise<{ change: Change; notified: boolean }> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "contribute");
  const author = await svc.store.getPrincipal(change.authorId);
  const mayAsk = change.authorId === caller.principal.id || author?.ownerId === caller.principal.id;
  if (!mayAsk) {
    throw forbidden("only the change's author (or its owner) may request a review", undefined, {
      explanation:
        "Only the change's author (or the human who owns that agent) can ask for its review.",
      call: `get_change_status({ changeId: "${change.id}" })`,
    });
  }
  if (TERMINAL.includes(change.status)) {
    throw conflict(`change is ${change.status}; nothing to review`, "invalid-state", {
      explanation: `The change is ${change.status}; there is nothing left to review. Start a new change for follow-up work.`,
      call: `start_change({ repoId: "${change.repoId}", title: "<title>", category: "fix" })`,
    });
  }
  const text = message?.trim()
    ? message.trim()
    : `${caller.principal.name} asks for a review of "${change.title}"`;
  await svc.notifier.notify({
    kind: "review-requested",
    changeId: change.id,
    repoId: change.repoId,
    message: text,
  });
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "change.review-requested",
    subject: `change:${change.id}`,
    payload: { headSha: change.headSha, status: change.status, message: text },
  });
  return { change, notified: true };
}

/**
 * `rerun_ci` / `POST /api/v1/changes/{changeId}/rerun`: CI, evidence, lane and tour again on the
 * same head (a flaky step no longer costs a re-dated push). The author (or the agent's owner) or
 * a maintainer; the coordinator checks the role and the status, and audits it.
 */
export async function rerunChangeCi(
  svc: Services,
  caller: Caller,
  changeId: string,
  reason: string | undefined,
): Promise<RerunResult> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  // A re-run costs CI minutes like a push: unclaimed projects pay it from their quota.
  await admitUnclaimedWork(svc, await requireRepo(svc, change.repoId), {
    ops: 0,
    what: "rerun_ci",
  });
  return svc.coordinator.rerun(caller.principal, changeId, reason);
}

/**
 * `close_change` / `POST /api/v1/changes/{changeId}/close`: abandon a change that won't merge
 * (stops CI, leaves the queue, deletes the fork later). The author (or the agent's owner) or a
 * maintainer; `reason` is audited. Closing a closed change returns it unchanged.
 */
export async function closeChange(
  svc: Services,
  caller: Caller,
  changeId: string,
  reason: string | undefined,
): Promise<Change> {
  await assertChangeAccess(svc, caller.principal, changeId, "read");
  return svc.coordinator.abandon(caller.principal, changeId, reason);
}
