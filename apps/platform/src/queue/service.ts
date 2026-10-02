/**
 * Merge-queue service functions shared by the HTTP routes and the MCP tools (one implementation
 * of every rule). The queue itself is the repo's `MergeQueue` Durable Object; this layer decides
 * who may act: scopes are checked by the callers, here the Change-level rules —
 *
 * - enqueue / dequeue / reprioritize: the Change's author, the human who owns the authoring
 *   agent, or a human reviewer (`change:review`). `enqueue` only records options: the
 *   ChangeWorkflow admits a Change (review, Lane 0, unclaimed projects never auto-merge).
 * - the incident class needs a human or an approved incident Plan (checked in the DO too).
 * - freeze / thaw / resume: humans with `repo:admin`; freeze and thaw are signed audit events.
 */
import type {
  QueueActor,
  QueueEntryView,
  QueueOverviewView,
  QueueRequest,
  QueueRequestResult,
  QueueResult,
  WaitForMergeResult,
} from "@app/coordinator";
import type { Change, ErrorFix } from "@app/domain";
import type { PriorityClass } from "@app/merge-queue";
import type { Caller, Services } from "../app-env.js";
import { ApiError, forbidden } from "../errors.js";
import { requireChange, requireRepo } from "../services/changes.js";

export interface QueueEventRow {
  seq: number;
  at: number;
  changeId: string | null;
  type: string;
  data: unknown;
}

/** The MergeQueue DO's RPC surface the platform uses (plain data both ways). */
export interface QueueRpc {
  queueRequest(repoId: string, input: QueueRequest): Promise<QueueResult<QueueRequestResult>>;
  queueStatus(repoId: string, changeId: string): Promise<QueueEntryView | null>;
  queueOverview(repoId: string): Promise<QueueOverviewView>;
  waitForMerge(repoId: string, changeId: string, timeoutMs: number): Promise<WaitForMergeResult>;
  dequeue(
    repoId: string,
    input: { changeId: string; by: QueueActor },
  ): Promise<QueueResult<{ status: QueueEntryView | null; removed: boolean }>>;
  reprioritize(
    repoId: string,
    input: {
      changeId: string;
      priority: PriorityClass;
      by: QueueActor;
      incidentPlanId?: string | null;
    },
  ): Promise<QueueResult<{ status: QueueEntryView | null }>>;
  setFrozen(
    repoId: string,
    input: {
      frozen: boolean;
      signer: { principalId: string; kind: "human"; signature: string };
      reason: string;
    },
  ): Promise<QueueResult<{ frozen: boolean }>>;
  queueEvents(
    repoId: string,
    input: { since: number; timeoutMs: number; changeId?: string },
  ): Promise<{ events: QueueEventRow[]; last: number }>;
  resume(repoId: string, by: string): Promise<void>;
}

export function queueOf(svc: Services, repoId: string): QueueRpc {
  return svc.env.MERGE_QUEUE.getByName(repoId) as unknown as QueueRpc;
}

const STATUS: Record<string, 400 | 403 | 404 | 409> = {
  forbidden: 403,
  "not-found": 404,
  "invalid-request": 400,
};

/** A refusal from the DO as the platform's error envelope. */
export function unwrap<T extends object>(r: QueueResult<T>): T {
  if (r.ok) return r;
  const fix: Partial<ErrorFix> = r.error.fix;
  throw new ApiError(STATUS[r.error.code] ?? 409, r.error.code, r.error.message, undefined, fix);
}

export function actorOf(caller: Caller): QueueActor {
  return { principalId: caller.principal.id, kind: caller.principal.kind, sessionId: null };
}

/** Author, the human owning the authoring agent, or a human reviewer. */
export async function requireQueueActor(
  svc: Services,
  caller: Caller,
  change: Change,
): Promise<void> {
  const p = caller.principal;
  if (p.id === change.authorId) return;
  if (p.kind === "human" && p.scopes.includes("change:review")) return;
  const author = await svc.store.getPrincipal(change.authorId);
  if (author?.kind === "agent" && author.ownerId === p.id) return;
  throw forbidden(
    "only the Change's author, its owner or a reviewer can change its queue entry",
    undefined,
    {
      explanation:
        "Ask the Change's author (or a human reviewer) to do it; anyone with repo:read can watch it.",
      call: `queue_status({ changeId: "${change.id}" })`,
    },
  );
}

export async function enqueueChange(
  svc: Services,
  caller: Caller,
  input: Omit<QueueRequest, "by">,
): Promise<QueueRequestResult> {
  const change = await requireChange(svc, input.changeId);
  await requireQueueActor(svc, caller, change);
  return unwrap(
    await queueOf(svc, change.repoId).queueRequest(change.repoId, {
      ...input,
      by: actorOf(caller),
    }),
  );
}

export async function queueStatus(svc: Services, changeId: string): Promise<QueueEntryView | null> {
  const change = await requireChange(svc, changeId);
  return queueOf(svc, change.repoId).queueStatus(change.repoId, changeId);
}

export async function waitForMerge(
  svc: Services,
  changeId: string,
  timeoutMs: number,
): Promise<WaitForMergeResult> {
  const change = await requireChange(svc, changeId);
  const ms = Math.min(Math.max(0, timeoutMs), 55_000);
  return queueOf(svc, change.repoId).waitForMerge(change.repoId, changeId, ms);
}

export async function dequeueChange(svc: Services, caller: Caller, changeId: string) {
  const change = await requireChange(svc, changeId);
  await requireQueueActor(svc, caller, change);
  return unwrap(
    await queueOf(svc, change.repoId).dequeue(change.repoId, { changeId, by: actorOf(caller) }),
  );
}

export async function reprioritizeChange(
  svc: Services,
  caller: Caller,
  input: { changeId: string; priority: PriorityClass; incidentPlanId?: string | null },
) {
  const change = await requireChange(svc, input.changeId);
  await requireQueueActor(svc, caller, change);
  return unwrap(
    await queueOf(svc, change.repoId).reprioritize(change.repoId, {
      ...input,
      by: actorOf(caller),
    }),
  );
}

export async function queueOverview(svc: Services, repoId: string): Promise<QueueOverviewView> {
  await requireRepo(svc, repoId);
  return queueOf(svc, repoId).queueOverview(repoId);
}

/** Human-signed freeze/thaw: the platform signs the document on the human's behalf (like plan approvals). */
export async function setQueueFrozen(
  svc: Services,
  caller: Caller,
  input: { repoId: string; frozen: boolean; reason: string },
): Promise<{ frozen: boolean }> {
  await requireRepo(svc, input.repoId);
  if (caller.principal.kind !== "human")
    throw forbidden("only a human may freeze or thaw the merge queue");
  const doc = {
    purpose: "gittifacts/audit-entry",
    action: input.frozen ? "merge-queue.freeze" : "merge-queue.thaw",
    repoId: input.repoId,
    principalId: caller.principal.id,
    reason: input.reason,
    at: svc.clock.now().toISOString(),
  };
  const signature = await (await svc.signer()).signDocument(doc);
  return unwrap(
    await queueOf(svc, input.repoId).setFrozen(input.repoId, {
      frozen: input.frozen,
      signer: { principalId: caller.principal.id, kind: "human", signature },
      reason: input.reason,
    }),
  );
}

export async function resumeQueue(svc: Services, caller: Caller, repoId: string): Promise<void> {
  await requireRepo(svc, repoId);
  if (caller.principal.kind !== "human")
    throw forbidden("only a human may resume a halted merge queue");
  await queueOf(svc, repoId).resume(repoId, caller.principal.id);
}
