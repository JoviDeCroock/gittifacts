/**
 * Reverts: opening the revert Change for a merged change (rollout regression or human kill), and
 * the platform's mechanical check that a change is the exact inverse of a merge
 * (`pureRevertVerified`). A revert Change is plan-less, claims `revert`, has `revertOf` set and
 * then flows through the normal lanes like any other change.
 */
import type { Change, ChangeDiff, ChangeDiffFile } from "@app/domain";
import type { CoordinatorBindings } from "./bindings.js";
import { changeSubject, forkNameFor, revertIdFor } from "./ids.js";
import { errorMessage } from "./policy.js";
import { type Ports, SYSTEM_PRINCIPAL_ID } from "./ports.js";

export interface RevertDeps {
  ports: Ports;
  bindings: CoordinatorBindings;
}

export interface OpenRevertResult {
  change: Change;
  /** How the inverse was produced; "conflict" means a human has to write the revert. */
  method: "tree" | "sandbox" | "conflict" | "existing";
  conflictFiles: string[];
}

/**
 * Idempotent: the revert's id is derived from the original's, so a retried step finds the change
 * it already created.
 */
export async function openRevertChange(
  deps: RevertDeps,
  input: { original: Change; reason: string; actorId?: string },
): Promise<OpenRevertResult> {
  const { ports, bindings } = deps;
  const { store, git, audit, clock } = ports;
  const { original, reason } = input;
  const actorId = input.actorId ?? SYSTEM_PRINCIPAL_ID;
  if (original.mergedSha === null) throw new Error(`change ${original.id} was never merged`);
  const repo = await store.getRepo(original.repoId);
  if (repo === null) throw new Error(`repo ${original.repoId} not found`);

  const revertId = revertIdFor(original.id);
  const existing = await store.getChange(revertId);
  if (existing !== null && existing.headSha !== null) {
    if (original.revertedBy !== revertId) await store.updateChange(original.id, { revertedBy: revertId });
    return { change: existing, method: "existing", conflictFiles: [] };
  }

  const forkName = forkNameFor(revertId);
  await git.forkRepo(repo.artifactsName, forkName);
  const forkHead = await git.branchHead(forkName, repo.defaultBranch);
  if (forkHead === null) throw new Error(`fork ${forkName} has no ${repo.defaultBranch}`);
  // A retried step may find the revert commit already pushed on top of the recorded base.
  const baseSha = existing?.baseSha ?? forkHead;
  const alreadyCommitted = existing !== null && forkHead !== existing.baseSha ? forkHead : null;

  const now = clock.now().toISOString();
  let change: Change =
    existing ??
    ({
      id: revertId,
      repoId: repo.id,
      planId: null,
      title: truncate(`Revert: ${original.title}`, 200),
      claim: { category: "revert", summary: truncate(reason, 10_000) },
      baseSha,
      headSha: null,
      forkName,
      authorId: SYSTEM_PRINCIPAL_ID,
      status: "awaiting-push",
      computedLane: null,
      lane: null,
      laneReasons: [],
      evidenceId: null,
      tourId: null,
      flagKey: null,
      mergedSha: null,
      rolloutState: null,
      revertOf: original.id,
      revertedBy: null,
      agentTraceId: null,
      createdAt: now,
      updatedAt: now,
    } satisfies Change);
  // Insert before pushing so the push event can resolve the change by its fork name.
  if (existing === null) await store.insertChange(change);

  const message = [
    `Revert "${original.title}"`,
    "",
    `This reverts commit ${original.mergedSha}.`,
    `Reverts change ${original.id}: ${reason}`,
  ].join("\n");

  let method: OpenRevertResult["method"];
  let headSha: string | null = null;
  let conflictFiles: string[] = [];
  if (alreadyCommitted !== null) {
    headSha = alreadyCommitted;
    method = "existing";
  } else if (baseSha === original.mergedSha) {
    // Main has not moved since the merge: the exact inverse is the pre-merge tree.
    const parents = await git.commitParents(forkName, original.mergedSha);
    const pre = parents?.[0];
    if (pre === undefined) throw new Error(`merge ${original.mergedSha} has no parent`);
    const tree = await git.treeOf(forkName, pre);
    if (tree === null) throw new Error(`tree of ${pre} not found`);
    ({ sha: headSha } = await git.commitTree(forkName, {
      treeSha: tree,
      parents: [baseSha],
      message,
      branch: repo.defaultBranch,
      expectedOld: baseSha,
    }));
    method = "tree";
  } else {
    const result = await ports.sandbox.revert({
      fork: forkName,
      sha: original.mergedSha,
      ontoSha: baseSha,
      branch: repo.defaultBranch,
      message,
    });
    if (result.status === "clean") {
      headSha = result.newSha;
      method = "sandbox";
    } else {
      conflictFiles = result.files;
      method = "conflict";
    }
  }

  await store.updateChange(original.id, { revertedBy: revertId });
  await audit.append({
    principalId: actorId,
    action: "change.revert-opened",
    subject: changeSubject(original.id),
    payload: { revertId, method, reason, mergedSha: original.mergedSha, baseSha, headSha, conflictFiles },
  });

  if (headSha !== null) {
    // The push event will also arrive; the ChangeCoordinator is idempotent per head.
    try {
      await bindings.changeCoordinator(revertId).onPush({
        changeId: revertId,
        ref: `refs/heads/${repo.defaultBranch}`,
        before: baseSha,
        after: headSha,
      });
    } catch (e) {
      await audit.append({
        principalId: SYSTEM_PRINCIPAL_ID,
        action: "change.revert-push-deferred",
        subject: changeSubject(revertId),
        payload: { error: errorMessage(e) },
      });
    }
    change = (await store.getChange(revertId)) ?? change;
  } else {
    await ports.notifier.notify({
      kind: "failing",
      changeId: revertId,
      repoId: repo.id,
      message: `Automatic revert of ${original.id} conflicted in ${conflictFiles.join(", ") || "unknown files"}; a human must write the revert.`,
    });
  }
  return { change, method, conflictFiles };
}

// ---------------------------------------------------------------- pure-revert verification

/**
 * True when `headSha` (on top of `baseSha`) is mechanically the exact inverse of the merge
 * `mergedSha`: either the head's tree equals the pre-merge tree with the merge as base, or the
 * diff base→head is the line-for-line inverse of the merge's own diff.
 */
export async function verifyPureRevert(
  git: Ports["git"],
  input: { repo: string; baseSha: string; headSha: string; mergedSha: string },
): Promise<boolean> {
  const parents = await git.commitParents(input.repo, input.mergedSha);
  const pre = parents?.[0];
  if (pre === undefined || parents === null || parents.length !== 1) return false;
  if (input.baseSha === input.mergedSha) {
    const [head, preTree] = await Promise.all([
      git.treeOf(input.repo, input.headSha),
      git.treeOf(input.repo, pre),
    ]);
    return head !== null && head === preTree;
  }
  const [forward, backward] = await Promise.all([
    git.diff(input.repo, pre, input.mergedSha),
    git.diff(input.repo, input.baseSha, input.headSha),
  ]);
  return isInverseDiff(forward, backward);
}

function changedLines(file: ChangeDiffFile): { added: string[]; deleted: string[] } {
  const added: string[] = [];
  const deleted: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added.push(line.text);
      else if (line.kind === "del") deleted.push(line.text);
    }
  }
  return { added, deleted };
}

const INVERSE_STATUS: Record<ChangeDiffFile["status"], ChangeDiffFile["status"] | null> = {
  added: "deleted",
  deleted: "added",
  modified: "modified",
  renamed: "renamed",
  "type-changed": "type-changed",
  copied: null,
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** `backward` undoes exactly what `forward` did, file by file and line by line. Pure. */
export function isInverseDiff(forward: ChangeDiff, backward: ChangeDiff): boolean {
  if (forward.files.length === 0 || forward.files.length !== backward.files.length) return false;
  if (forward.additions !== backward.deletions || forward.deletions !== backward.additions) return false;
  const byPath = new Map(backward.files.map((f) => [f.path, f] as const));
  for (const f of forward.files) {
    // A rename a→b is undone by a rename b→a, which lands at a.
    const inverseKey = f.status === "renamed" ? (f.previousPath ?? f.path) : f.path;
    const b = byPath.get(inverseKey);
    if (b === undefined) return false;
    if (INVERSE_STATUS[f.status] !== b.status) return false;
    if (f.status === "renamed" && b.previousPath !== f.path) return false;
    // Without hunks we cannot prove anything: unknown is not verified.
    if (f.binary || b.binary || f.truncated || b.truncated) return false;
    if (f.additions !== b.deletions || f.deletions !== b.additions) return false;
    const fl = changedLines(f);
    const bl = changedLines(b);
    if (!sameList(fl.added, bl.deleted) || !sameList(fl.deleted, bl.added)) return false;
  }
  return true;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
