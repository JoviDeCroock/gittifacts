/**
 * Identifier conventions shared by the service, the Durable Objects and the Workflows.
 * Everything here is deterministic except `newId`.
 */

/** Change forks live next to the main repos as `task-<changeId>`. Main repos may not use the prefix. */
export const FORK_PREFIX = "task-";

/** Branch in a fork where the merge queue's sandbox pushes a rebased head (ignored by onPush). */
export const REBASE_BRANCH = "gittifacts/rebased";

export const ZERO_SHA = "0".repeat(40);

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
