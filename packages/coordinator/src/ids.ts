/**
 * Identifier conventions shared by the service, the Durable Objects and the Workflows.
 * Everything here is deterministic except `newId`.
 */
import type { Change } from "@app/domain";
import { SYSTEM_PRINCIPAL_ID } from "./ports.js";

/** Change forks live next to the main repos as `task-<changeId>`. Main repos may not use the prefix. */
export const FORK_PREFIX = "task-";

/**
 * Artifacts repos the platform keeps for itself (template cache seeding); no project may use the
 * prefix.
 */
export const SEED_PREFIX = "seed-";

/** The merge queue's per-repo scratch repos (`mqs-<repoId>`): no project may use the prefix. */
export const QUEUE_SCRATCH_PREFIX = "mqs-";

/** Prefix of a repo's bootstrap Change (its first CI run and preview). */
export const BOOTSTRAP_PREFIX = "bs-";

/** The bootstrap Change of `repoId`: one per repo, so creating it is idempotent. */
export function bootstrapChangeIdFor(repoId: string): string {
  return `${BOOTSTRAP_PREFIX}${repoId}`;
}

/**
 * A repo's bootstrap Change: platform-authored, base = head = the initial commit, checked out from
 * the main repo itself (no fork). It has no lane and never reaches review or the merge queue.
 * Regular change ids never contain "-", so the prefix cannot collide.
 */
export function isBootstrapChange(change: Pick<Change, "id" | "authorId">): boolean {
  return change.id.startsWith(BOOTSTRAP_PREFIX) && change.authorId === SYSTEM_PRINCIPAL_ID;
}

/** Branch in a fork where the merge queue's sandbox pushes a rebased head (ignored by onPush). */
export const REBASE_BRANCH = "gittifacts/rebased";

export const ZERO_SHA = "0".repeat(40);

/**
 * Two shas for a message: 12 characters each when that tells them apart, the full shas when the
 * short forms collide (M5 dogfood: "review is for eb99ce836502 but the change's head is
 * eb99ce836502" after a mistyped full sha).
 */
export function distinctShas(a: string, b: string): [string, string] {
  return a.slice(0, 12) === b.slice(0, 12) ? [a, b] : [a.slice(0, 12), b.slice(0, 12)];
}

/** 20 chars of [0-9a-z]: short enough for fork names, flag keys and workflow ids. */
export function newId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function forkNameFor(changeId: string): string {
  return `${FORK_PREFIX}${changeId}`;
}

export function isForkName(name: string): boolean {
  return name.startsWith(FORK_PREFIX);
}

/** One ChangeWorkflow instance per (change, head). Reviews and merge events address it by this id. */
export function changeWorkflowId(changeId: string, headSha: string): string {
  return `${changeId}-${headSha.slice(0, 12)}`;
}

/** One RolloutWorkflow per merged change. */
export function rolloutWorkflowId(changeId: string): string {
  return `rollout-${changeId}`;
}

/** The CI run for a ChangeWorkflow instance (one full run per head). */
export function ciRunIdFor(workflowInstanceId: string): string {
  return `run-${workflowInstanceId}`;
}

/** The cheap re-check run the merge queue starts after a rebase. */
export function cheapRunIdFor(changeId: string, rebasedSha: string): string {
  return `mq-${changeId}-${rebasedSha.slice(0, 12)}`;
}

export function flagKeyFor(changeId: string): string {
  return `change-${changeId}`;
}

export function stagingRefFor(changeId: string): string {
  return `refs/merge-queue/${changeId}`;
}

/** Deterministic id of the revert Change opened for `changeId` (idempotent revert creation). */
export function revertIdFor(changeId: string): string {
  const id = `rv-${changeId}`;
  if (id.length <= 60) return id;
  // Reverts of reverts of …: keep it bounded and still deterministic.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return `rv-${changeId.slice(0, 40)}-${h.toString(36)}`;
}

export function evidenceIdFor(changeId: string, headSha: string): string {
  return `ev-${changeId}-${headSha.slice(0, 12)}`;
}

export const changeSubject = (changeId: string): string => `change:${changeId}`;
export const repoSubject = (repoId: string): string => `repo:${repoId}`;

/**
 * The branch a change's head lives on in its fork repo: natively the fork's default branch; a
 * GitHub pull request's head is `gittifacts/pr/<n>` in the repo's mirror (`Change.host`).
 */
export function headBranchOf(
  change: { host?: { headBranch: string } | null },
  repo: { defaultBranch: string },
): string {
  return change.host?.headBranch ?? repo.defaultBranch;
}
