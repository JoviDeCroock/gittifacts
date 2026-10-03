/**
 * Reviews of a change whose host merges it (GitHub mode, spec §3.4): a GitHub PR review, the
 * check run's "Approve tour" button and the platform UI all land here and become the same
 * `ReviewDecision` record. The rules are the platform's own:
 * - humans only: agents and bots never review (an agent never approves an agent's PR);
 * - nobody reviews their own change;
 * - a review binds to a head: one for an older head is not recorded;
 * - only a graded head can be reviewed.
 * Whoever calls has already checked the reviewer may review the repo (GitHub: write access).
 */
import type { Lane, ReviewDecision } from "@app/domain";
import { changeSubject, newId as makeId } from "./ids.js";
import type { Ports } from "./ports.js";

export interface HostReviewInput {
  changeId: string;
  headSha: string;
  reviewer: { principalId: string; kind: "human" | "agent" | "bot" };
  decision: ReviewDecision["decision"];
  source: NonNullable<ReviewDecision["source"]>;
  humanLane?: Lane | null;
  comment?: string | null;
  /** Deterministic id for at-least-once deliveries (e.g. `ghr-<review id>`). */
  id?: string;
}

export type HostReviewOutcome =
  | { recorded: true; review: ReviewDecision; duplicate: boolean }
  | { recorded: false; reason: string };

/** Which statuses a GitHub Change can be reviewed in (graded, not closed). */
const REVIEWABLE = new Set(["awaiting-review", "approved", "awaiting-push", "failing"]);

export async function recordHostReview(
  ports: Pick<Ports, "store" | "audit" | "clock">,
  input: HostReviewInput,
): Promise<HostReviewOutcome> {
  const { store, audit, clock } = ports;
  const change = await store.getChange(input.changeId);
  if (change === null) return { recorded: false, reason: "unknown change" };
  if (change.host == null) return { recorded: false, reason: "a native change is reviewed through its workflow" };
  if (input.reviewer.kind !== "human") {
    return { recorded: false, reason: "only humans review; agents and bots never approve" };
  }
  if (input.reviewer.principalId === change.authorId) {
    return { recorded: false, reason: "no principal reviews its own change" };
  }
  if (change.headSha !== input.headSha) {
    return { recorded: false, reason: `the review is for ${input.headSha.slice(0, 12)}, the head is ${change.headSha?.slice(0, 12) ?? "none"}` };
  }
  if (!REVIEWABLE.has(change.status)) return { recorded: false, reason: `change is ${change.status}` };
  const classification = await store.getClassification(change.id, input.headSha);
  if (classification === null) return { recorded: false, reason: "this head is not graded yet" };
  if (input.id !== undefined) {
    const prior = (await store.listReviews?.(change.id))?.find((r) => r.id === input.id);
    if (prior !== undefined) return { recorded: true, review: prior, duplicate: true };
  }
  const review: ReviewDecision = {
    id: input.id ?? makeId(),
    changeId: change.id,
    headSha: input.headSha,
    reviewerId: input.reviewer.principalId,
    decision: input.decision,
    humanLane: input.humanLane ?? null,
    computedLane: classification.computedLane,
    comment: input.comment ?? null,
    source: input.source,
    createdAt: clock.now().toISOString(),
  };
  await store.putReview(review);
  await store.updateChange(change.id, {
    status: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "awaiting-push",
  });
  await audit.append({
    principalId: review.reviewerId,
    action: "change.reviewed",
    subject: changeSubject(change.id),
    payload: {
      reviewId: review.id,
      headSha: review.headSha,
      decision: review.decision,
      humanLane: review.humanLane,
      computedLane: review.computedLane,
      lane: classification.lane,
      shadow: classification.shadow,
      requiresHumanApproval: classification.requiresHumanApproval,
      source: review.source,
    },
  });
  return { recorded: true, review, duplicate: false };
}
