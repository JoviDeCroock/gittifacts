/**
 * The merge queue's sandbox work (`QueueJobs` port). Containers only run git and
 * `gittifacts-runner`; they write to the queue's scratch repo (`mqs-<repoId>`) and never hold a
 * token for the main repo. The MergeQueue DO copies results into the main repo itself (it is the
 * only writer of `refs/queue/*` and of the default branch).
 */
import { z } from "zod";

/** One head to replay: `replayBase..headSha` is the Change's own work. */
export interface ReplaySpec {
  changeId: string;
  headSha: string;
  replayBase: string;
  /** Artifacts repo holding `headSha` (the Change's fork, or the scratch repo). */
  repo: string;
  /**
   * How many commits `replayBase..headSha` holds when it is a straight line the squashed commit's
   * message lists (DECISIONS 2026-10-03: one commit per Change); absent: nothing to list.
   */
  commits?: number;
}

const Sha = z.string().regex(/^[0-9a-f]{40,64}$/);

export const BuildResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("clean"),
    tipSha: Sha,
    treeSha: Sha,
    commits: z.array(z.object({ changeId: z.string(), commitSha: Sha, treeSha: Sha })).min(1),
  }),
  z.object({
    status: z.literal("conflict"),
    changeId: z.string(),
    files: z.array(z.string()).max(1000),
    /** Commits in `replayBase..onto` that touched a conflicted path. */
    upstreamCommits: z.array(Sha).max(200).default([]),
  }),
  /** The replay failed for a reason other than a conflict (infrastructure, bad input). */
  z.object({ status: z.literal("error"), changeId: z.string().nullable(), note: z.string() }),
]);
export type BuildResult = z.infer<typeof BuildResult>;

export interface QueueJobs {
  /** Create the scratch repo (a fork of the main repo) if it does not exist. */
  ensureScratch(input: { mainRepo: string; scratch: string }): Promise<void>;
  /**
   * Replay `entries` in order onto `baseSha` (`gittifacts-runner merge-attempt`, one commit per
   * entry) in the scratch repo and point `ref` there at the tip. `baseSha` must exist in
   * `baseRepo`. Stops at the first entry that does not apply.
   */
  buildBatch(input: {
    scratch: string;
    baseRepo: string;
    baseSha: string;
    entries: ReplaySpec[];
    ref: string;
  }): Promise<BuildResult>;
  /** `gittifacts-runner affected --base --head` (raw `::affected::` document). */
  affected(input: { repo: string; baseSha: string; headSha: string }): Promise<unknown>;
  /**
   * Prepare a resolution: replay `preceding` onto `ontoSha` (they must apply cleanly), then
   * `merge-attempt` the Change on top. `ontoSha` = P, the commit the attempt was made onto;
   * `doc` = the raw `::merge::` document; the conflict (or clean) commit is pushed to `ref`.
   */
  mergeAttempt(input: {
    scratch: string;
    baseRepo: string;
    ontoSha: string;
    preceding: ReplaySpec[];
    change: ReplaySpec;
    ref: string;
  }): Promise<{ ontoSha: string; doc: unknown }>;
  /** `gittifacts-runner apply-resolution --patch --onto` in scratch; the result is pushed to `ref`. */
  applyResolution(input: {
    scratch: string;
    patch: string;
    onto: string;
    ref: string;
  }): Promise<unknown>;
}
