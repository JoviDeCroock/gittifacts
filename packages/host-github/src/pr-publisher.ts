/**
 * The PR writes beyond the check run (spec §3.4): the tour review per head, staling older ones,
 * the summary comment, and the collaborator check approvals need. Every write goes through the
 * installation's write gate (`GithubApi.write`). Writes only happen when the repo has PR writes on
 * (`enabled`: the installation is linked and nobody turned them off; DECISIONS 2026-10-03).
 */
import type { Ports } from "@app/coordinator";
import type { Tour } from "@app/domain";
import { type GithubApi, GithubHttpError } from "./api.js";
import type { PrIndex } from "./pr-index.js";
import { bodyHash, staleReviewBody, staleStopBody, summaryBody, tourReview, type SummaryState } from "./pr-writes.js";

export interface PrPublisherDeps {
  api: GithubApi;
  owner: string;
  repo: string;
  ports: Pick<Ports, "store" | "clock">;
  prs: PrIndex;
  /** PR writes are on for this repo. */
  enabled(): Promise<boolean>;
  detailsUrl(changeId: string): string;
  shadow: boolean;
}

const MINIMIZE = "mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }";
const SOURCE_WORD = { platform: "on gittifacts", "github-review": "GitHub review", "github-check": "check run" } as const;

export class PrPublisher {
  constructor(private readonly d: PrPublisherDeps) {}

  private path(suffix: string) {
    return `/repos/${this.d.owner}/${this.d.repo}${suffix}`;
  }

  /** Post the tour as the head's one review (nothing for Lane 0); idempotent per head. */
  async publishTour(changeId: string, number: number, tour: Tour): Promise<"posted" | "exists" | "skipped"> {
    if (!(await this.d.enabled())) return "skipped";
    const cls = await this.d.ports.store.getClassification(changeId, tour.headSha);
    if (cls === null || cls.lane === 0) return "skipped";
    const prior = await this.d.prs.review(changeId, tour.headSha);
    if (prior !== null && prior.staleAt === null) return "exists";
    const url = this.d.detailsUrl(changeId);
    let posted: { id: number; node_id: string };
    try {
      posted = await this.d.api.write("POST", this.path(`/pulls/${number}/reviews`), tourReview(tour, cls, url));
    } catch (e) {
      // A stop GitHub won't anchor (outside the diff it shows) fails the whole review: post the
      // stops in the body instead, rather than no tour at all.
      if (!(e instanceof GithubHttpError) || e.status !== 422) throw e;
      posted = await this.d.api.write("POST", this.path(`/pulls/${number}/reviews`), tourReview(tour, cls, url, { inline: false }));
    }
    const comments = (await this.d.api.get(this.path(`/pulls/${number}/reviews/${posted.id}/comments?per_page=100`))) as { id: number }[];
    await this.d.prs.putReview({
      changeId,
      headSha: tour.headSha,
      reviewId: posted.id,
      nodeId: posted.node_id,
      commentIds: comments.map((c) => c.id),
      staleAt: null,
    });
    return "posted";
  }

  /** Older heads' reviews: body and stops say "stale", and the review is minimized. */
  async staleOlder(changeId: string, number: number, newHead: string, opts: { sameHeadToo?: boolean } = {}): Promise<number> {
    if (!(await this.d.enabled())) return 0;
    let n = 0;
    for (const r of await this.d.prs.reviews(changeId)) {
      if ((r.headSha === newHead && opts.sameHeadToo !== true) || r.staleAt !== null) continue;
      const url = this.d.detailsUrl(changeId);
      await this.d.api.write("PUT", this.path(`/pulls/${number}/reviews/${r.reviewId}`), { body: staleReviewBody(r.headSha, newHead, url) });
      for (const id of r.commentIds) {
        await this.d.api.write("PATCH", this.path(`/pulls/comments/${id}`), { body: staleStopBody(r.headSha) });
      }
      await this.d.api.write("POST", "/graphql", { query: MINIMIZE, variables: { id: r.nodeId } });
      await this.d.prs.markStale(changeId, r.headSha, this.d.ports.clock.now().toISOString());
      n++;
    }
    return n;
  }

  private async state(changeId: string): Promise<SummaryState | null> {
    const { store } = this.d.ports;
    const change = await store.getChange(changeId);
    if (change?.headSha == null) return null;
    const head = change.headSha;
    const [cls, tour, review, plan, reviews, full] = await Promise.all([
      store.getClassification(changeId, head),
      store.getTour?.(changeId, head) ?? Promise.resolve(null),
      this.d.prs.review(changeId, head),
      change.planId === null ? Promise.resolve(null) : store.getPlan(change.planId),
      store.listReviews?.(changeId) ?? Promise.resolve([]),
      this.d.prs.fullReviews(changeId, head),
    ]);
    const name = async (id: string) => {
      const p = await store.getPrincipal(id);
      const n = p?.name ?? id;
      return n.endsWith(" (GitHub)") ? `@${n.slice(0, -" (GitHub)".length)}` : n;
    };
    const atHead = reviews.filter((r) => r.headSha === head);
    const people = async (decision: "approve" | "request-changes") =>
      Promise.all(atHead.filter((r) => r.decision === decision).map(async (r) => ({ by: await name(r.reviewerId), via: SOURCE_WORD[r.source ?? "platform"] })));
    return {
      headSha: head,
      verdict: cls === null ? null : { lane: cls.lane, shadow: cls.shadow, blocked: cls.blocked },
      tour: review !== null ? "posted" : cls === null ? "pending" : cls.lane === 0 ? "not-needed" : tour === null ? "pending" : "pending",
      stops: tour?.stops.length ?? 0,
      plan: plan === null ? null : { title: plan.title, approved: plan.status === "approved" },
      approvals: await people("approve"),
      changesRequested: await people("request-changes"),
      fullReview: full.map((f) => ({ by: `@${f.by}` })),
      detailsUrl: this.d.detailsUrl(changeId),
      shadow: this.d.shadow,
    };
  }

  /** The summary comment: created once something needs a human, then edited only when it changes. */
  async publishSummary(changeId: string, number: number): Promise<"created" | "edited" | "unchanged" | "skipped"> {
    if (!(await this.d.enabled())) return "skipped";
    const state = await this.state(changeId);
    if (state === null) return "skipped";
    const existing = await this.d.prs.summary(changeId);
    // Lane 0 gets only the check run (spec §3.4), unless a summary already exists to keep current.
    if (existing === null && (state.verdict === null || (state.verdict.lane === 0 && !state.verdict.blocked))) return "skipped";
    const body = summaryBody(state);
    const hash = await bodyHash(body);
    if (existing !== null && existing.hash === hash) return "unchanged";
    if (existing === null) {
      const c = (await this.d.api.write("POST", this.path(`/issues/${number}/comments`), { body })) as { id: number };
      await this.d.prs.putSummary(changeId, c.id, hash);
      return "created";
    }
    await this.d.api.write("PATCH", this.path(`/issues/comments/${existing.commentId}`), { body });
    await this.d.prs.putSummary(changeId, existing.commentId, hash);
    return "edited";
  }

  /** "Request full review" from the check run's button (state; shown in the summary). */
  async recordFullReview(changeId: string, headSha: string, login: string): Promise<void> {
    await this.d.prs.addFullReview(changeId, headSha, login);
  }

  /** Write access (admin, maintain or write) on the repo, by GitHub's own answer. */
  async canWrite(login: string): Promise<boolean> {
    try {
      const p = (await this.d.api.get(this.path(`/collaborators/${encodeURIComponent(login)}/permission`))) as { permission?: string; role_name?: string };
      return ["admin", "maintain", "write"].includes(p.role_name ?? "") || ["admin", "write"].includes(p.permission ?? "");
    } catch {
      return false; // unknown → no
    }
  }
}
