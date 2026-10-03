/**
 * Artifacts deliveries → normalized host events. Artifacts sends `cf.artifacts.repo.pushed`
 * (through `triggers.events` to the PushRouter): a push to a change fork is `change.updated`, a
 * push to a main repo's default branch is `main.advanced` (only the merge queue writes it).
 *
 * Native `change.opened`, `review.submitted` and `change.closed` come from the platform's own API
 * (start a change, submit a review, abandon), not from deliveries, so `normalize` never emits them.
 */
import { isForkName, type Ports, parsePushEvent, ZERO_SHA } from "@app/coordinator";
import type { HostEvent } from "@app/host";
import { nativeRef } from "./ref.js";

/** How far back `forced` looks for the previous head before calling the push a force-push. */
export const ANCESTRY_LIMIT = 200;

export async function normalizeArtifactsEvent(
  ports: Pick<Ports, "store" | "git">,
  raw: unknown,
): Promise<HostEvent[]> {
  const push = parsePushEvent(raw, ports.git.namespace);
  if (!push.ok || push.after === ZERO_SHA || !push.ref.startsWith("refs/heads/")) return [];
  const { repoName, ref, before, after } = push;
  if (isForkName(repoName)) {
    const change = await ports.store.getChangeByFork(repoName);
    if (change === null) return [];
    const repo = await ports.store.getRepo(change.repoId);
    if (repo === null || ref !== `refs/heads/${repo.defaultBranch}`) return [];
    const previous = before === ZERO_SHA || before === change.baseSha ? null : before;
    const forced =
      previous === null ? false : !(await isAncestor(ports.git, repoName, previous, after));
    return [
      {
        type: "change.updated",
        ref: nativeRef(change),
        headSha: after,
        previousHeadSha: previous,
        forced,
      },
    ];
  }
  const repo = await ports.store.getRepoByArtifactsName(repoName);
  if (repo === null || ref !== `refs/heads/${repo.defaultBranch}`) return [];
  return [
    {
      type: "main.advanced",
      repo: { host: "artifacts", repoId: repo.id },
      branch: repo.defaultBranch,
      before: before === ZERO_SHA ? null : before,
      after,
    },
  ];
}

/** Bounded ancestry walk; unknown (missing commits, too deep) counts as "not an ancestor". */
async function isAncestor(
  git: Pick<Ports["git"], "commitParents">,
  repo: string,
  ancestor: string,
  head: string,
): Promise<boolean> {
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length > 0 && seen.size < ANCESTRY_LIMIT) {
    const sha = queue.shift() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const parents = await git.commitParents(repo, sha);
    if (parents === null) return false;
    queue.push(...parents);
  }
  return false;
}
