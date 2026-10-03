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
import type { PrIndex } from "./pr-index.js";
import { PrPublisher } from "./pr-publisher.js";
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
  /** PR writes beyond the check run (M3): where they are recorded, and whether they're on. */
  prs?: PrIndex;
  prWrites?(): Promise<boolean>;
}

const CATEGORIES: readonly ClaimedCategory[] = ["fix", "feature", "refactor", "dependency", "transform", "revert", "docs", "chore"];
const PREFIXES: Record<string, ClaimedCategory> = {
  fix: "fix", feat: "feature", feature: "feature", refactor: "refactor", deps: "dependency",
  dependency: "dependency", build: "dependency", transform: "transform", codemod: "transform",
  revert: "revert", docs: "docs", chore: "chore", test: "chore", ci: "chore",
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
  /** Tour reviews, the summary comment, collaborator checks (null without a PR index). */
  readonly publisher: PrPublisher | null;

  constructor(private readonly deps: GitHubHostDeps) {
    const prs = deps.prs;
    this.publisher =
      prs === undefined
        ? null
        : new PrPublisher({
            api: deps.api,
            owner: deps.repo.owner,
            repo: deps.repo.repo,
            ports: deps.ports,
            prs,
            enabled: deps.prWrites ?? (async () => false),
            detailsUrl: (id) => this.detailsUrl(id),
            shadow: deps.shadow ?? true,
          });
  }

  /** One job (a workflow step): its installation token is revoked when it ends. */
  private async job<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      await this.deps.onJobEnd?.();
    }
  }

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

  /** An issue (not a PR), or null. */
  async issue(number: number): Promise<{
    number: number;
    title: string;
    body: string | null;
    user: { login: string; id: number; type: string };
    labels: { name: string }[];
  } | null> {
    try {
      const i = (await this.deps.api.get(this.path(`/issues/${number}`))) as Record<string, unknown>;
      if (i.pull_request !== undefined || typeof i.title !== "string") return null;
      const user = i.user as { login: string; id: number; type?: string };
      return {
        number,
        title: i.title,
        body: typeof i.body === "string" ? i.body : null,
        user: { login: user.login, id: user.id, type: user.type ?? "User" },
        labels: ((i.labels ?? []) as { name?: string }[]).map((l) => ({ name: String(l.name ?? "") })),
      };
    } catch {
      return null;
    }
  }

  /** Who last applied `label` to an issue, and when (its timeline), or null. */
  async labeledBy(number: number, label: string): Promise<{ login: string; id: number; type: string; at: string } | null> {
    const events = (await this.deps.api.get(this.path(`/issues/${number}/events?per_page=100`))) as {
      event?: string;
      label?: { name?: string };
      actor?: { login: string; id: number; type?: string } | null;
      created_at?: string;
    }[];
    const last = events.filter((e) => e.event === "labeled" && e.label?.name === label && e.actor).at(-1);
    return last?.actor ? { login: last.actor.login, id: last.actor.id, type: last.actor.type ?? "User", at: last.created_at ?? "" } : null;
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
  async startCheck(changeId: string, headSha: string, opts: { fresh?: boolean } = {}): Promise<number> {
    // A re-grade of the same head gets a run of its own (the earlier one keeps its verdict).
    const known = opts.fresh === true ? null : await this.deps.checks.get(changeId, headSha);
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
    await this.job(() => this.completeCheck(this.changeId(ref), verdict));
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

  /** The tour as the head's one PR review (Lane ≥ 1, PR writes on); idempotent per head. */
  async publishTour(ref: ChangeRef, tour: Tour): Promise<void> {
    const r = this.own(ref);
    const p = this.publisher;
    if (p === null) return;
    await this.job(() => p.publishTour(this.changeId(r), r.number, tour));
  }

  /** The summary comment, edited in place only when its text changes. */
  async publishSummary(ref: ChangeRef): Promise<void> {
    const r = this.own(ref);
    const p = this.publisher;
    if (p === null) return;
    await this.job(() => p.publishSummary(this.changeId(r), r.number));
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
