import type { ClassifyResult } from "@app/classifier";
import type { GitRemoteGrant } from "@app/coordinator";
import {
  type AuditEvent,
  type Change,
  type ChangeDiff,
  type Evidence,
  type Lane,
  type LinkedIssue,
  type PipelineRun,
  type Plan,
  type RolloutState,
  StartChangeInput,
  type Tour,
} from "@app/domain";
import type { z } from "zod";
import type { ReviewBody } from "../api/schemas.js";
import type { Caller, Services } from "../app-env.js";
import { conflict, forbidden, notFound } from "../errors.js";
import type { ChangeSummary } from "../store/d1-store.js";

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
  repoId: string,
  filter: { statuses?: Change["status"][] | undefined; lane?: Lane | undefined },
): Promise<ChangeSummary[]> {
  await requireRepo(svc, repoId);
  return svc.store.listChangeSummaries(repoId, {
    ...(filter.statuses ? { statuses: filter.statuses } : {}),
    ...(filter.lane !== undefined ? { lane: filter.lane } : {}),
  });
}

export interface ChangeDetail {
  change: Change;
  plan: Plan | null;
  runs: PipelineRun[];
  classification: ClassifyResult | null;
}

export async function getChangeDetail(svc: Services, changeId: string): Promise<ChangeDetail> {
  const change = await requireChange(svc, changeId);
  const [plan, runs, classification] = await Promise.all([
    change.planId ? svc.store.getPlan(change.planId) : Promise.resolve(null),
    svc.store.listRuns(change.id),
    change.headSha ? svc.store.getClassification(change.id, change.headSha) : Promise.resolve(null),
  ]);
  return { change, plan, runs, classification };
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

export async function getChangeDiff(svc: Services, changeId: string): Promise<ChangeDiff> {
  const change = await requireChange(svc, changeId);
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
  changeId: string,
): Promise<EvidenceWithVerification> {
  const change = await requireChange(svc, changeId);
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

export async function getChangeTour(svc: Services, changeId: string): Promise<Tour> {
  const change = await requireChange(svc, changeId);
  const head = requireHead(change);
  const tour =
    (change.tourId ? await svc.store.getTourById(change.tourId) : null) ??
    (await svc.store.getTour(change.id, head));
  if (!tour || tour.headSha !== head) throw notReady(change, "The tour", head);
  return tour;
}

export async function getChangeRollout(
  svc: Services,
  changeId: string,
): Promise<{ rollout: RolloutState | null; timeline: AuditEvent[] }> {
  const change = await requireChange(svc, changeId);
  const timeline = await svc.store.auditTimeline(svc.auditLog, `change:${change.id}`);
  return { rollout: change.rolloutState, timeline };
}

export async function listChangeIssues(svc: Services, changeId: string): Promise<LinkedIssue[]> {
  const change = await requireChange(svc, changeId);
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
  await requireRepo(svc, v.repoId);
  if (v.planId !== undefined && !(await svc.store.getPlan(v.planId))) {
    throw notFound(`plan ${v.planId}`, {
      explanation:
        "A change implements a plan. Draft one, get a human to approve it, then start the change.",
      call: `create_plan({ repoId: "${v.repoId}", title: "<title>", intent: "<why>", acceptanceCriteria: ["<observable result>"] })`,
    });
  }
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
  await requireChange(svc, changeId);
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
  await requireChange(svc, changeId);
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
  await requireChange(svc, changeId);
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
  const change = await requireChange(svc, changeId);
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
