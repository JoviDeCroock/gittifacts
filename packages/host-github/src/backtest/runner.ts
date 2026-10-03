/**
 * The backtest (spec §3.7, research §8): grade the last N merged PRs of a repo with the live
 * pipeline, then correlate with later reverts and 14-day line patches, and report.
 *
 * - "What landed" is graded: base = the merge commit's first parent, head = the merge commit.
 *   Both are on the default branch, so the mirror already has them (no PR heads, no forks).
 * - Each PR is a backtest Change (`ghb-<repo>-<n>`) graded by the real ChangeWorkflow (CI on the
 *   mirror, evidence, judge, classify; no tour, nothing written to GitHub), in waves of a few at a
 *   time so the CI containers aren't flooded.
 * - Every step is a durable step (`step`), every wait a durable sleep (`sleep`), so a Workflow can
 *   run it for an hour and resume where it stopped.
 */
import { type ChangeCoordinatorClient, type Ports, ZERO_SHA } from "@app/coordinator";
import type { Change, Repo } from "@app/domain";
import type { Identity } from "@app/host";
import { claimedCategoryOf } from "../adapter.js";
import type { GithubApi } from "../api.js";
import { classifyAuthor } from "../identity.js";
import type { GithubSource } from "../sync.js";
import { listMergedPrs, type MergedPr } from "./listing.js";
import { findPatches, type PatchOutcome } from "./patches.js";
import { type BacktestReport, backtestReport, type GradedPr } from "./report.js";
import { findReverts } from "./reverts.js";

export const backtestChangeId = (githubRepoId: number, number: number) => `ghb-${githubRepoId}-${number}`;
export const backtestBranch = (number: number) => `gittifacts/backtest/${number}`;

export interface BacktestDeps {
  /** `github` role ports (writes the mirror's backtest branches). */
  ports: Ports;
  api: Pick<GithubApi, "graphql">;
  repo: Repo;
  coordinator(changeId: string): Pick<ChangeCoordinatorClient, "onPush">;
  source(): Promise<GithubSource>;
  authorPrincipal(identity: Identity & { login: string }): Promise<string>;
  /** A durable step: same name → same result on replay. Results are plain JSON. */
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** A durable sleep between polls. */
  sleep(name: string, ms: number): Promise<void>;
}

export interface BacktestInput {
  since: string;
  until: string;
  /** Grade at most this many (the newest); all listed PRs still count for reverts and patches. */
  maxPrs?: number;
  wave?: number;
  pollMs?: number;
  /** Polls per wave before its stragglers are skipped as "not graded in time". */
  maxPolls?: number;
}

const HEAD_QUERY = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { defaultBranchRef { target { oid } } } }`;

export async function runBacktest(deps: BacktestDeps, input: BacktestInput): Promise<BacktestReport> {
  const { repo } = deps;
  const host = repo.host;
  if (host == null) throw new Error(`${repo.id} is not a GitHub repository`);
  const { owner, repo: name, githubRepoId } = host;
  const mirror = repo.artifactsName;

  // Graded: the newest `maxPrs` that merged at least 14 days ago (their outcome is known). Kept:
  // everything from the first graded PR on (later reverts and patches), trimmed so the step
  // result stays small (a Workflow step result is ≤ 1 MB).
  const listing = await deps.step("list", async () => {
    const all = await listMergedPrs(deps.api, { owner, repo: name, defaultBranch: repo.defaultBranch, since: new Date(input.since), until: new Date(input.until) });
    const settled = new Date(input.until).getTime() - 14 * 86_400_000;
    const old = all.prs.filter((p) => Date.parse(p.mergedAt) <= settled);
    const toGrade = (old.length > 0 ? old : all.prs).slice(-(input.maxPrs ?? 50));
    const from = toGrade[0]?.mergedAt ?? input.until;
    const prs = all.prs
      .filter((p) => p.mergedAt >= from)
      .map((p) => ({ ...p, body: p.body?.slice(0, 500) ?? null, files: p.files.slice(0, 100) }));
    return { prs, grade: toGrade.map((p) => p.number), pages: all.pages, points: all.points, truncated: all.truncated };
  });
  // The mirror's default branch: the newest history (every merge commit of the window is in it).
  await deps.step("mirror", async () => {
    const out = (await deps.api.graphql(HEAD_QUERY, { owner, repo: name })) as { repository: { defaultBranchRef: { target: { oid: string } } | null } };
    const head = out.repository.defaultBranchRef?.target.oid;
    if (head === undefined) throw new Error("the repository has no default branch");
    const src = await deps.source();
    try {
      await deps.ports.git.fetchExternal?.(src.remote, mirror, { sha: head, toRef: `refs/heads/${repo.defaultBranch}` });
    } finally {
      await src.release();
    }
    return head;
  });

  const gradeSet = new Set(listing.grade);
  const toGrade = listing.prs.filter((p) => gradeSet.has(p.number));
  const wave = input.wave ?? 4;
  const graded = new Map<number, GradedPr>();
  const skipped: { number: number; reason: string }[] = [];
  for (let w = 0; w * wave < toGrade.length; w++) {
    const batch = toGrade.slice(w * wave, (w + 1) * wave);
    for (const pr of batch) {
      const started = await deps.step(`start-${pr.number}`, () => startOne(deps, pr, githubRepoId));
      if (started !== null) skipped.push({ number: pr.number, reason: started });
    }
    const pending = new Set(batch.filter((p) => !skipped.some((s) => s.number === p.number)).map((p) => p.number));
    for (let poll = 0; pending.size > 0 && poll < (input.maxPolls ?? 120); poll++) {
      const done = await deps.step(`wave-${w}-poll-${poll}`, () => readGraded(deps, githubRepoId, batch.filter((p) => pending.has(p.number))));
      for (const g of done) {
        graded.set(g.number, g);
        pending.delete(g.number);
      }
      if (pending.size > 0) await deps.sleep(`wave-${w}-sleep-${poll}`, input.pollMs ?? 30_000);
    }
    for (const n of pending) skipped.push({ number: n, reason: "not graded in time" });
  }

  const outcomes = await deps.step("outcomes", async () => {
    const reverts = findReverts(listing.prs, `${owner}/${name}`);
    const patches = await findPatches(listing.prs, {
      diff: (base, head) => deps.ports.git.diff(mirror, base, head),
      parent: async (sha) => (await deps.ports.git.commitParents(mirror, sha))?.[0] ?? null,
    }, { now: new Date(input.until) });
    return { reverts: [...reverts], patches: [...patches] as [number, PatchOutcome][] };
  });
  return backtestReport({
    since: new Date(input.since),
    until: new Date(input.until),
    listed: listing.prs,
    graded,
    skipped,
    reverts: new Map(outcomes.reverts),
    patches: new Map(outcomes.patches),
  });
}

/** Create the backtest Change for a merged PR and start its grading. Null, or why it's skipped. */
async function startOne(deps: BacktestDeps, pr: MergedPr, githubRepoId: number): Promise<string | null> {
  const { store, git, clock } = deps.ports;
  const mirror = deps.repo.artifactsName;
  const id = backtestChangeId(githubRepoId, pr.number);
  const existing = await store.getChange(id);
  if (existing?.headSha === pr.mergeSha) return null; // graded by an earlier run (or in flight)
  const parent = (await git.commitParents(mirror, pr.mergeSha))?.[0];
  if (parent === undefined) return "the merge commit isn't in the mirror";
  const branch = backtestBranch(pr.number);
  const current = await git.branchHead(mirror, branch);
  if (current !== pr.mergeSha) {
    const moved = await git.updateRef(mirror, `refs/heads/${branch}`, current ?? ZERO_SHA, pr.mergeSha);
    if (!moved.ok) return `couldn't point ${branch} at the merge commit (${moved.reason})`;
  }
  if (existing === null) {
    const login = pr.author?.login ?? "ghost";
    const who: Identity & { login: string } = {
      kind: classifyAuthor({ login, type: pr.author?.type ?? "User", headRef: pr.headRefName }),
      id: String(pr.author?.id ?? 0),
      login,
    };
    const now = clock.now().toISOString();
    const change: Change = {
      id,
      repoId: deps.repo.id,
      planId: null,
      title: (pr.title || `#${pr.number}`).slice(0, 200),
      claim: { category: claimedCategoryOf({ title: pr.title, labels: pr.labels.map((name) => ({ name })) }) ?? "feature", summary: null },
      baseSha: parent,
      headSha: null,
      forkName: mirror,
      authorId: await deps.authorPrincipal(who),
      status: "awaiting-push",
      computedLane: null,
      lane: null,
      laneReasons: [],
      evidenceId: null,
      tourId: null,
      flagKey: null,
      mergedSha: null,
      rolloutState: null,
      revertOf: null,
      revertedBy: null,
      agentTraceId: null,
      host: {
        kind: "github",
        number: pr.number,
        headBranch: branch,
        fork: false,
        headRepo: null,
        baseRef: deps.repo.defaultBranch,
        author: { login, id: pr.author?.id ?? 0, kind: who.kind },
        url: `https://github.com/${deps.repo.host?.owner}/${deps.repo.host?.repo}/pull/${pr.number}`,
        backtest: true,
        mergedSha: pr.mergeSha,
      },
      createdAt: now,
      updatedAt: now,
    };
    await store.insertChange(change);
  }
  const pushed = await deps.coordinator(id).onPush({ changeId: id, ref: `refs/heads/${branch}`, before: ZERO_SHA, after: pr.mergeSha });
  return pushed.action === "ignored" ? `not started: ${pushed.reason}` : null;
}

/** The PRs of a wave whose grading finished (their classification for the merge commit exists). */
async function readGraded(deps: BacktestDeps, githubRepoId: number, prs: readonly MergedPr[]): Promise<GradedPr[]> {
  const out: GradedPr[] = [];
  for (const pr of prs) {
    const id = backtestChangeId(githubRepoId, pr.number);
    const change = await deps.ports.store.getChange(id);
    if (change?.status !== "merged") continue;
    const cls = await deps.ports.store.getClassification(id, pr.mergeSha);
    if (cls === null) continue;
    out.push({
      number: pr.number,
      lane: cls.lane,
      computedLane: cls.computedLane,
      blocked: cls.blocked,
      requiresHumanApproval: cls.requiresHumanApproval,
      reasons: cls.reasons.map((r) => ({ code: r.code, lane: r.lane })),
    });
  }
  return out;
}
