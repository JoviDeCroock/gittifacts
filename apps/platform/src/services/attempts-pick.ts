/**
 * A person picks one attempt at a plan (`POST /api/v1/plans/{planId}/attempts/{changeId}/pick`).
 *
 * - Only a human with review rights on the repo, who did not author the picked Change. Picking
 *   approves it through the normal review path (services/changes.ts `submitReview`): the approval
 *   binds to the head the person saw, and an approval is what sends a Change to the merge queue.
 * - The Change must be awaiting review, or already approved / queued (then nothing is approved
 *   again). The plan must be approved: people approve intent before they choose how it's done.
 * - One pick per plan, recorded first so two people picking at once can't both win; a failed
 *   approval takes the pick back.
 * - The other open attempts are closed (abandoned) by the platform, with a reason that names the
 *   pick; `wait_for_change` then answers their agents `superseded`. Audited: `plan.attempt-picked`
 *   and `change.superseded` per closed attempt, both by the person who picked.
 */
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import type { Change, Principal } from "@app/domain";
import { assertChangeAccess, assertPlanAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import { conflict, forbidden, notFound } from "../errors.js";
import type { PlanPick } from "../store/d1-store.js";
import { type PickedView, pickedView, rankPlanAttempts } from "./attempts.js";
import { submitReview } from "./changes.js";

/** Statuses an attempt can still be closed from (it hasn't landed or ended). */
const OPEN: ReadonlySet<Change["status"]> = new Set([
  "awaiting-push",
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
]);
const CLEARED: ReadonlySet<Change["status"]> = new Set(["approved", "queued"]);

export interface PickResult {
  planId: string;
  picked: PickedView;
  change: Change;
  /** True when this pick approved the Change (false: it was already approved). */
  approved: boolean;
  superseded: Array<{ changeId: string; title: string; status: Change["status"] }>;
  notClosed: Array<{ changeId: string; error: string }>;
}

const statusCall = (changeId: string) => `get_change_status({ changeId: "${changeId}" })`;

export async function pickAttempt(
  svc: Services,
  caller: Caller,
  planId: string,
  changeId: string,
  body: { headSha?: string | undefined; comment?: string | undefined },
  idempotencyKey?: string,
): Promise<PickResult> {
  const person = caller.principal;
  if (person.kind !== "human") throw forbidden("only a person picks an attempt");
  const plan = await assertPlanAccess(svc, person, planId, "read");
  const change = await assertChangeAccess(svc, person, changeId, "review");
  if (change.planId !== planId) {
    throw notFound(`attempt ${changeId} at plan ${planId}`, {
      explanation: `Change ${changeId} does not implement plan ${planId}. Compare the plan's attempts to find one.`,
      call: `compare_attempts({ planId: "${planId}" })`,
    });
  }
  if (plan.status !== "approved") {
    throw conflict(`plan ${planId} is ${plan.status}, not approved`, "invalid-state", {
      explanation: "Approve the plan's intent first; then pick how it is done.",
      call: `get_plan({ planId: "${planId}" })`,
    });
  }
  const existing = await svc.store.getPlanPick(planId);
  if (existing !== null && existing.changeId !== changeId) {
    throw conflict(`another attempt (${existing.changeId}) was already picked`, "already-picked", {
      explanation: `Plan ${planId} already has its pick: ${existing.changeId}. Compare the attempts to see it.`,
      call: `compare_attempts({ planId: "${planId}" })`,
    });
  }
  const reviewable = change.status === "awaiting-review";
  if (existing === null && !reviewable && !CLEARED.has(change.status)) {
    throw conflict(`change ${changeId} is ${change.status}; it can't be picked`, "invalid-state", {
      explanation:
        change.status === "running" || change.status === "awaiting-push"
          ? "It is still grading. Pick it once it is awaiting review."
          : "Only an attempt awaiting review (or already approved) can be picked.",
      call: statusCall(changeId),
    });
  }
  if (change.authorId === person.id) {
    throw forbidden("no principal picks (approves) its own change", undefined, {
      explanation: "Ask another person with review rights to pick among the attempts.",
      call: `compare_attempts({ planId: "${planId}" })`,
    });
  }

  // Claim the pick first: of two people picking at once, one wins.
  const now = svc.clock.now().toISOString();
  const pick =
    existing ??
    (await svc.store.putPlanPick({
      planId,
      changeId,
      pickedBy: person.id,
      headSha: body.headSha ?? change.headSha,
      pickedAt: now,
    }));
  if (pick.changeId !== changeId) {
    throw conflict(`another attempt (${pick.changeId}) was just picked`, "already-picked", {
      explanation: `Someone picked ${pick.changeId} a moment ago.`,
      call: `compare_attempts({ planId: "${planId}" })`,
    });
  }
  let approved = false;
  if (reviewable) {
    const ranking = await rankPlanAttempts(svc, planId);
    const others = ranking.attempts.length - 1;
    try {
      await submitReview(
        svc,
        caller,
        changeId,
        {
          decision: "approve",
          ...(body.headSha !== undefined ? { headSha: body.headSha } : {}),
          comment:
            body.comment?.trim() ||
            `Picked among ${others + 1} attempts at plan "${plan.title}"${ranking.recommended?.changeId === changeId ? " (the recommended one)" : ""}.`,
        },
        idempotencyKey === undefined ? undefined : `pick:${idempotencyKey}`,
      );
      approved = true;
    } catch (err) {
      // The approval didn't happen: the pick doesn't stand either (unless it was already there).
      if (existing === null)
        await svc.store.deletePlanPick(planId, changeId).catch(() => undefined);
      throw err;
    }
  }
  return closeOthers(svc, caller, { planId, changeId, approved, pick });
}

/** The platform itself: it closes the attempts a person didn't pick (the coordinator lets it). */
async function systemPrincipal(svc: Services): Promise<Principal> {
  return (
    (await svc.store.getPrincipal(SYSTEM_PRINCIPAL_ID)) ?? {
      id: SYSTEM_PRINCIPAL_ID,
      kind: "system",
      name: "gittifacts",
      ownerId: null,
      keys: [],
      scopes: [],
    }
  );
}

/** Close every other open attempt at the plan, as the platform, on the person's pick. */
async function closeOthers(
  svc: Services,
  caller: Caller,
  p: { planId: string; changeId: string; approved: boolean; pick: PlanPick },
): Promise<PickResult> {
  const person = caller.principal;
  const system = await systemPrincipal(svc);
  const attempts = await svc.store.listChangesForPlan(p.planId);
  const superseded: PickResult["superseded"] = [];
  const notClosed: PickResult["notClosed"] = [];
  for (const other of attempts) {
    if (other.id === p.changeId || !OPEN.has(other.status)) continue;
    const reason = `superseded: ${person.name} picked ${p.changeId} among the attempts at plan ${p.planId}`;
    try {
      const closed = await svc.coordinator.abandon(system, other.id, reason);
      superseded.push({ changeId: other.id, title: other.title, status: closed.status });
      await svc.audit.append({
        principalId: person.id,
        action: "change.superseded",
        subject: `change:${other.id}`,
        payload: {
          planId: p.planId,
          pickedChangeId: p.changeId,
          previousStatus: other.status,
          headSha: other.headSha,
        },
      });
    } catch (err) {
      notClosed.push({
        changeId: other.id,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      });
    }
  }
  const change = await svc.store.getChange(p.changeId);
  if (change === null) throw notFound(`change ${p.changeId}`);
  await svc.audit.append({
    principalId: person.id,
    action: "plan.attempt-picked",
    subject: `plan:${p.planId}`,
    payload: {
      changeId: p.changeId,
      headSha: change.headSha,
      approved: p.approved,
      superseded: superseded.map((s) => s.changeId),
      notClosed: notClosed.map((n) => n.changeId),
    },
  });
  const picked = await pickedView(svc, p.pick);
  if (picked === null) throw new Error("unreachable: a pick view of a pick");
  return { planId: p.planId, picked, change, approved: p.approved, superseded, notClosed };
}

/**
 * `wait_for_change` for an attempt a person did not pick: the Change ended (abandoned) and its
 * plan's pick is another Change. Returns that Change's id, or null.
 */
export async function supersededBy(svc: Services, change: Change): Promise<string | null> {
  if (change.planId === null || change.status !== "abandoned") return null;
  const pick = await svc.store.getPlanPick(change.planId);
  return pick !== null && pick.changeId !== change.id ? pick.changeId : null;
}
