/**
 * Normalized host events. Every host translates its own deliveries (Artifacts push events, GitHub
 * webhooks) into these, so the coordinator reacts to one vocabulary. Deliveries are untrusted:
 * adapters validate the raw payload, and these schemas validate what crosses into the core.
 */
import { z } from "zod";
import { ChangeRef, RepoRef } from "./ref.js";

const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export const Identity = z.object({
  kind: z.enum(["human", "agent", "bot"]),
  /** Host-scoped id (native: principal id; GitHub: numeric user id as a string). */
  id: z.string().min(1).max(200),
  login: z.string().max(200).nullable().default(null),
});
export type Identity = z.infer<typeof Identity>;

export const ChangeOpened = z.object({
  type: z.literal("change.opened"),
  ref: ChangeRef,
  headSha: Sha,
  baseSha: Sha,
  author: Identity.nullable().default(null),
});

export const ChangeUpdated = z.object({
  type: z.literal("change.updated"),
  ref: ChangeRef,
  headSha: Sha,
  previousHeadSha: Sha.nullable(),
  /** The previous head is not an ancestor of the new one (force-push). Unknown → true. */
  forced: z.boolean(),
});

export const ChangeClosed = z.object({
  type: z.literal("change.closed"),
  ref: ChangeRef,
  merged: z.boolean(),
  mergedSha: Sha.nullable().default(null),
});

export const ReviewSubmitted = z.object({
  type: z.literal("review.submitted"),
  ref: ChangeRef,
  /** Reviews bind to a head: approving an older head does nothing. */
  headSha: Sha,
  reviewer: Identity,
  decision: z.enum(["approve", "request-changes", "reject", "comment"]),
});

export const MainAdvanced = z.object({
  type: z.literal("main.advanced"),
  repo: RepoRef,
  branch: z.string().min(1),
  before: Sha.nullable(),
  after: Sha,
});

export const QueueGroupCreated = z.object({
  type: z.literal("queue.group_created"),
  repo: RepoRef,
  /** Host-side id of the group (GitHub: the merge_group head ref). */
  groupId: z.string().min(1),
  /** The tree that would land, and what it lands on. */
  headSha: Sha,
  baseSha: Sha,
  changes: z.array(ChangeRef),
});

export const HostEvent = z.discriminatedUnion("type", [
  ChangeOpened,
  ChangeUpdated,
  ChangeClosed,
  ReviewSubmitted,
  MainAdvanced,
  QueueGroupCreated,
]);
export type HostEvent = z.infer<typeof HostEvent>;
export type HostEventType = HostEvent["type"];

/**
 * A host's event source. Hosts deliver events by push (Artifacts `triggers.events`, GitHub
 * webhooks through a Queue), so the stream is "normalize each delivery"; `subscribe` exists for
 * in-process hosts and tests.
 */
export interface HostEvents {
  /** Translate one raw delivery into zero or more normalized events (unknown → []). */
  normalize(raw: unknown): Promise<HostEvent[]>;
  subscribe?(listener: (event: HostEvent) => void): () => void;
}
