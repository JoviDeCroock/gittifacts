/**
 * `GitHubHost`: the GitHub App adapter (spec §2, §3), built per installation and repository so
 * `capabilities()` can differ per repo. M2 is shadow mode: it reads pull requests, materializes
 * them from the Artifacts mirror, and publishes the `gittifacts/lane` check run. It never merges,
 * comments or reviews; `merge` still checks the expected head first (stale heads are refused).
 */
import type { Ports } from "@app/coordinator";
import type { ClaimedCategory, GithubRepoHost, Tour } from "@app/domain";
import {
  type ChangeMeta,
  type ChangeRef,
  type DiffInfo,
  type HostAdapter,
  type HostCapabilities,
  type HostEvents,
  HostError,
  type LaneVerdict,
  type MergeMethod,
  type MergeResult,
  type SandboxCheckout,
} from "@app/host";
import type { GithubApi } from "./api.js";
import { type GithubRepoSetup, githubCapabilities } from "./capabilities.js";
import { type CheckRunContext, completedCheckRun, startedCheckRun, supersededCheckRun } from "./check-run.js";
import { changeIdFor } from "./ids.js";
import { identityOf, normalizeGithubDelivery } from "./normalize.js";
import { type GithubDelivery, PullRequest } from "./payloads.js";

/** Check run ids per (change, head): created when grading starts, completed once. */
export interface CheckRunIndex {
  get(changeId: string, headSha: string): Promise<number | null>;
  put(changeId: string, headSha: string, checkRunId: number): Promise<void>;
}

export function memoryCheckRunIndex(): CheckRunIndex {
  const m = new Map<string, number>();
  return {
    get: async (c, h) => m.get(`${c}@${h}`) ?? null,
    put: async (c, h, id) => {
      m.set(`${c}@${h}`, id);
    },
  };
}

export interface GitHubHostDeps {
  repoId: string;
  /** The Artifacts mirror (the platform repo's `artifactsName`). */
  mirror: string;
  repo: GithubRepoHost;
  api: GithubApi;
  ports: Pick<Ports, "store" | "git" | "clock">;
  checks: CheckRunIndex;
  /** The platform's browser origin (details_url). */
  origin: string;
  setup?: GithubRepoSetup;
  /** Always true in M2. */
  shadow?: boolean;
  /** End of a job that used the API (revokes its installation token). */
  onJobEnd?(): Promise<void>;
}

const CATEGORIES: readonly ClaimedCategory[] = ["fix", "feature", "refactor", "dependency", "transform", "revert", "docs", "chore"];
const PREFIXES: Record<string, ClaimedCategory> = {
  fix: "fix", feat: "feature", feature: "feature", refactor: "refactor", deps: "dependency",
  build: "dependency", revert: "revert", docs: "docs", chore: "chore", test: "chore", ci: "chore",
};

/** The author's claim: a `gittifacts:<category>` label, else a conventional-commit title prefix. */
export function claimedCategoryOf(pr: { title: string; labels: { name: string }[] }): ClaimedCategory | null {
  for (const l of pr.labels) {
    const m = /^gittifacts:([a-z]+)$/.exec(l.name);
    if (m !== null && CATEGORIES.includes(m[1] as ClaimedCategory)) return m[1] as ClaimedCategory;
  }
  const t = /^\s*([a-z]+)(\([^)]*\))?!?:/i.exec(pr.title);
  return t === null ? null : (PREFIXES[(t[1] ?? "").toLowerCase()] ?? null);
}

/**
 * A Plan created on the platform and referenced in the PR body (spec §3.5 c): a line
 * `gittifacts-plan: <plan id>`. Linked issues and plan files come in M3.
 */
export function planRefOf(body: string | null): string | null {
  const m = /^\s*gittifacts-plan:\s*([A-Za-z0-9_-]{1,64})\s*$/m.exec(body ?? "");
  return m === null ? null : (m[1] ?? null);
}

export class GitHubHost implements HostAdapter {
  readonly kind = "github" as const;
  constructor(private readonly deps: GitHubHostDeps) {}

  capabilities(): HostCapabilities {
    return githubCapabilities(this.deps.setup);
  }

  private own(ref: ChangeRef): Extract<ChangeRef, { host: "github" }> {
    if (ref.host !== "github") throw new HostError("wrong-host", "not a GitHub pull request");
    const { owner, repo } = this.deps.repo;
    if (ref.owner.toLowerCase() !== owner.toLowerCase() || ref.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new HostError("wrong-host", `${ref.owner}/${ref.repo} is not ${owner}/${repo}`);
    }
    return ref;
  }

  private changeId(ref: ChangeRef): string {
    return changeIdFor(this.deps.repo.githubRepoId, this.own(ref).number);
  }

  private path(suffix: string): string {
    return `/repos/${this.deps.repo.owner}/${this.deps.repo.repo}${suffix}`;
  }

  async pull(number: number) {
    const parsed = PullRequest.safeParse(await this.deps.api.get(this.path(`/pulls/${number}`)));
    if (!parsed.success) throw new HostError("invalid", `pull request #${number}: unexpected answer`);
    return parsed.data;
  }

  async getChange(ref: ChangeRef): Promise<ChangeMeta> {
    const r = this.own(ref);
    const pr = await this.pull(r.number);
    const row = await this.deps.ports.store.getChange(this.changeId(r));
    const fork = pr.head.repo === null || pr.head.repo.id !== this.deps.repo.githubRepoId;
    return {
      ref: r,
      title: pr.title,
      body: pr.body,
      author: identityOf(pr.user, { headRef: pr.head.ref }),
      baseBranch: pr.base.ref,
      baseSha: row?.baseSha ?? pr.base.sha,
      headSha: pr.head.sha,
      category: claimedCategoryOf(pr),
      planRefs: planRefOf(pr.body) === null ? [] : [planRefOf(pr.body) as string],
      revertOf: null,
      agentTraceId: null,
      source: { fork, repo: pr.head.repo?.full_name ?? "(deleted fork)" },
      state: pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open",
    };
  }

  /** A read-only checkout of the mirror at `sha` (fork code included: it only ever runs in a sandbox). */
  async materialize(ref: ChangeRef, sha: string): Promise<SandboxCheckout> {
    const r = this.own(ref);
    const { git } = this.deps.ports;
    if ((await git.commitParents(this.deps.mirror, sha)) === null) {
      throw new HostError("not-found", `${sha.slice(0, 12)} is not in the mirror yet`);
    }
    const token = await git.mintToken(this.deps.mirror, "read", 600);
    return {
      ref: r,
      sha,
      artifactsRepo: this.deps.mirror,
      remote: git.remoteOf(this.deps.mirror),
      token: { scope: "read", value: token.token, expiresAt: token.expiresAt },
      writable: false,
    };
  }

  async diff(ref: ChangeRef): Promise<DiffInfo> {
    const id = this.changeId(ref);
    const change = await this.deps.ports.store.getChange(id);
    if (change?.headSha == null) throw new HostError("not-found", `${id} has no head yet`);
    const stored = await this.deps.ports.store.getDiff(id, change.headSha);
    return stored ?? this.deps.ports.git.diff(this.deps.mirror, change.baseSha, change.headSha);
  }

  /** The merge base of a PR (`GET /compare/{base}...{head}`, ETag-cached); `base` if unknown. */
  async mergeBase(base: string, head: string): Promise<string> {
    try {
      const out = (await this.deps.api.get(this.path(`/compare/${base}...${head}`))) as {
        merge_base_commit?: { sha?: unknown };
      };
      const sha = out.merge_base_commit?.sha;
      return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : base;
    } catch {
      return base;
    }
  }

  private detailsUrl(changeId: string): string {
    return `${this.deps.origin}/changes/${encodeURIComponent(changeId)}`;
  }

  /** Open the in-progress run for a head as soon as grading starts (idempotent per head). */
  async startCheck(changeId: string, headSha: string): Promise<number> {
    const known = await this.deps.checks.get(changeId, headSha);
    if (known !== null) return known;
    const body = startedCheckRun({
      headSha,
      changeId,
      detailsUrl: this.detailsUrl(changeId),
      shadow: this.deps.shadow ?? true,
      startedAt: this.deps.ports.clock.now().toISOString(),
    });
    const run = (await this.deps.api.write("POST", this.path("/check-runs"), body)) as { id: number };
    await this.deps.checks.put(changeId, headSha, run.id);
    return run.id;
  }

  /** A head replaced before it was graded: its run is closed as cancelled, never left running. */
  async supersedeCheck(changeId: string, oldHead: string, newHead: string): Promise<void> {
    const id = await this.deps.checks.get(changeId, oldHead);
    if (id === null) return;
    const now = this.deps.ports.clock.now().toISOString();
    await this.deps.api.write("PATCH", this.path(`/check-runs/${id}`), supersededCheckRun(newHead, now));
  }

  async publishVerdict(ref: ChangeRef, verdict: LaneVerdict): Promise<void> {
    // Only the final verdict for a head reaches GitHub: the run is updated once.
    if (verdict.preliminary) return;
    try {
      await this.completeCheck(this.changeId(ref), verdict);
    } finally {
      await this.deps.onJobEnd?.();
    }
  }

  private async completeCheck(changeId: string, verdict: LaneVerdict): Promise<void> {
    const evidence = await this.deps.ports.store.getEvidence(changeId, verdict.headSha);
    const ctx: CheckRunContext = {
      changeId,
      detailsUrl: this.detailsUrl(changeId),
      shadow: this.deps.shadow ?? true,
      evidence: (evidence?.items ?? []).map((i) => {
        const item = i as { kind: string; status?: unknown; note?: unknown };
        return {
          kind: item.kind,
          status: typeof item.status === "string" ? item.status : "recorded",
          note: typeof item.note === "string" ? item.note : null,
        };
      }),
    };
    const body = completedCheckRun(verdict, ctx, this.deps.ports.clock.now().toISOString());
    const id = await this.deps.checks.get(changeId, verdict.headSha);
    if (id !== null) {
      await this.deps.api.write("PATCH", this.path(`/check-runs/${id}`), body);
      return;
    }
    // Grading started without a run (GitHub was down then): create it completed, in one write.
    const run = (await this.deps.api.write("POST", this.path("/check-runs"), {
      ...body,
      head_sha: verdict.headSha,
    })) as { id: number };
    await this.deps.checks.put(changeId, verdict.headSha, run.id);
  }

  /** Shadow mode: the tour stays on the platform (one PR review from M3). */
  async publishTour(ref: ChangeRef, _tour: Tour): Promise<void> {
    this.own(ref);
  }

  /** Shadow mode: no review requests on GitHub. */
  async requestReview(ref: ChangeRef): Promise<void> {
    this.own(ref);
  }

  async merge(ref: ChangeRef, input: { expectedHeadSha: string; method: MergeMethod }): Promise<MergeResult> {
    const r = this.own(ref);
    const pr = await this.pull(r.number);
    if (pr.state === "closed") {
      return { status: "refused", reason: "closed", detail: `#${r.number} is closed`, currentHeadSha: pr.head.sha };
    }
    if (pr.head.sha !== input.expectedHeadSha) {
      return {
        status: "refused",
        reason: "stale-head",
        detail: `#${r.number} moved to ${pr.head.sha.slice(0, 12)}; that head is graded instead`,
        currentHeadSha: pr.head.sha,
      };
    }
    return {
      status: "refused",
      reason: "not-allowed",
      detail: "shadow mode: the platform never merges on GitHub (needs the Actor App, M5)",
      currentHeadSha: pr.head.sha,
    };
  }

  async revert(): Promise<ChangeRef> {
    throw new HostError("forbidden", "revert pull requests on GitHub come with the Actor App (M5)");
  }

  events(): HostEvents {
    return { normalize: async (raw) => normalizeGithubDelivery(raw as GithubDelivery) };
  }
}
