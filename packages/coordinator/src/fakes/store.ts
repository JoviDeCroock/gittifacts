/** In-memory Store. Rows are deep-copied in and out, like a database. */
import type { ClassifyResult, ShadowSample } from "@app/classifier";
import type {
  Change,
  ChangeDiff,
  Evidence,
  LinkedIssue,
  PipelineRun,
  Plan,
  Principal,
  Repo,
  RepoPolicy,
  ReviewDecision,
  Tour,
} from "@app/domain";
import type { Clock, Store } from "../ports.js";

const clone = <T>(v: T): T => structuredClone(v);

export class FakeStore implements Store {
  readonly repos = new Map<string, Repo>();
  readonly plans = new Map<string, Plan>();
  readonly changes = new Map<string, Change>();
  readonly runs = new Map<string, PipelineRun>();
  readonly diffs = new Map<string, ChangeDiff>();
  readonly evidence = new Map<string, Evidence>();
  readonly classifications = new Map<string, ClassifyResult>();
  readonly tours = new Map<string, Tour>();
  readonly reviews = new Map<string, ReviewDecision>();
  readonly issues = new Map<string, LinkedIssue & { scriptName: string; raw: unknown }>();
  readonly principals = new Map<string, Principal>();
  private lastUpdate = 0;

  constructor(private readonly clock: Clock) {}

  /** Strictly increasing timestamps so `updatedAt` always changes on update. */
  private stamp(): string {
    const t = Math.max(this.clock.now().getTime(), this.lastUpdate + 1);
    this.lastUpdate = t;
    return new Date(t).toISOString();
  }

  // ------------------------------------------------------------ test helpers
  addPrincipal(p: Principal): Principal {
    this.principals.set(p.id, clone(p));
    return p;
  }
  addPlan(p: Plan): Plan {
    this.plans.set(p.id, clone(p));
    return p;
  }

  // ------------------------------------------------------------ repos
  async getRepo(id: string) {
    const r = this.repos.get(id);
    return r === undefined ? null : clone(r);
  }
  async getRepoByArtifactsName(name: string) {
    const r = [...this.repos.values()].find((x) => x.artifactsName === name);
    return r === undefined ? null : clone(r);
  }
  async insertRepo(repo: Repo) {
    if (this.repos.has(repo.id)) throw new Error(`repo ${repo.id} exists`);
    this.repos.set(repo.id, clone(repo));
  }
  async updateRepo(id: string, patch: Partial<Omit<Repo, "id" | "createdAt">>) {
    const r = this.repos.get(id);
    if (r === undefined) throw new Error(`repo ${id} not found`);
    const next = { ...r, ...clone(patch) };
    this.repos.set(id, next);
    return clone(next);
  }
  async setRepoPolicy(repoId: string, policy: RepoPolicy, sha: string) {
    await this.updateRepo(repoId, { policy, policySha: sha });
  }

  // ------------------------------------------------------------ plans
  async getPlan(id: string) {
    const p = this.plans.get(id);
    return p === undefined ? null : clone(p);
  }

  // ------------------------------------------------------------ changes
  async getChange(id: string) {
    const c = this.changes.get(id);
    return c === undefined ? null : clone(c);
  }
  async getChangeByFork(forkName: string) {
    const c = [...this.changes.values()].find((x) => x.forkName === forkName);
    return c === undefined ? null : clone(c);
  }
  async insertChange(change: Change) {
    if (this.changes.has(change.id)) throw new Error(`change ${change.id} exists`);
    this.changes.set(change.id, clone(change));
  }
  async updateChange(id: string, patch: Partial<Omit<Change, "id" | "repoId" | "createdAt">>) {
    const c = this.changes.get(id);
    if (c === undefined) throw new Error(`change ${id} not found`);
    const next: Change = { ...c, ...clone(patch), updatedAt: this.stamp() };
    this.changes.set(id, next);
    return clone(next);
  }
  async listChanges(repoId: string, statuses: Change["status"][]) {
    return [...this.changes.values()].filter((c) => c.repoId === repoId && statuses.includes(c.status)).map(clone);
  }
  async getChangeByRolloutVersion(versionId: string) {
    const c = [...this.changes.values()].find((x) => x.rolloutState?.versionId === versionId);
    return c === undefined ? null : clone(c);
  }

  // ------------------------------------------------------------ runs, diffs, evidence
  async upsertRun(run: PipelineRun) {
    this.runs.set(run.id, clone(run));
  }
  async getRun(id: string) {
    const r = this.runs.get(id);
    return r === undefined ? null : clone(r);
  }
  async putDiff(changeId: string, diff: ChangeDiff) {
    this.diffs.set(`${changeId}:${diff.headSha}`, clone(diff));
  }
  async getDiff(changeId: string, headSha: string) {
    const d = this.diffs.get(`${changeId}:${headSha}`);
    return d === undefined ? null : clone(d);
  }
  async putEvidence(evidence: Evidence) {
    this.evidence.set(`${evidence.changeId}:${evidence.headSha}`, clone(evidence));
  }
  async getEvidence(changeId: string, headSha: string) {
    const e = this.evidence.get(`${changeId}:${headSha}`);
    return e === undefined ? null : clone(e);
  }
  async putClassification(changeId: string, headSha: string, result: ClassifyResult) {
    this.classifications.set(`${changeId}:${headSha}`, clone(result));
  }
  async getClassification(changeId: string, headSha: string) {
    const c = this.classifications.get(`${changeId}:${headSha}`);
    return c === undefined ? null : clone(c);
  }
  async putTour(tour: Tour) {
    this.tours.set(tour.id, clone(tour));
  }

  // ------------------------------------------------------------ reviews, shadow
  async putReview(review: ReviewDecision) {
    this.reviews.set(review.id, clone(review));
  }
  async listShadowSamples(repoId: string): Promise<ShadowSample[]> {
    return [...this.reviews.values()]
      .filter((r) => this.changes.get(r.changeId)?.repoId === repoId)
      .map((r) => ({ computedLane: r.computedLane, humanLane: r.humanLane, decision: r.decision }));
  }

  // ------------------------------------------------------------ issues, principals
  async putIssue(issue: LinkedIssue & { scriptName: string; raw: unknown }) {
    this.issues.set(issue.id, clone(issue));
  }
  async listIssues(filter: { versionId?: string; changeId?: string; since?: string }) {
    return [...this.issues.values()]
      .filter(
        (i) =>
          (filter.versionId === undefined || i.versionId === filter.versionId) &&
          (filter.changeId === undefined || i.changeId === filter.changeId) &&
          (filter.since === undefined || i.lastSeen >= filter.since),
      )
      .map(({ scriptName: _s, raw: _r, ...issue }) => clone(issue));
  }
  async getPrincipal(id: string) {
    const p = this.principals.get(id);
    return p === undefined ? null : clone(p);
  }
}
