/**
 * D1 (Drizzle) implementation of the coordinator's `Store` port, plus the read models the HTTP
 * API and MCP tools need (summaries, counts, audit mirror). All reads are zod-parsed into domain
 * types in ./rows.ts.
 */
import type { ClassifyResult, ShadowSample } from "@app/classifier";
import type { Store } from "@app/coordinator";
import {
  type AuditEvent,
  type Change,
  ChangeDiff,
  Evidence,
  Lane,
  type LinkedIssue,
  PipelineRun,
  type Plan,
  type Principal,
  type Repo,
  RepoPolicy,
  ReviewDecision,
  Tour,
} from "@app/domain";
import { and, asc, desc, eq, gte, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { isHumanPrincipal, ownerMembershipInsert } from "../access/members-store.js";
import * as schema from "../db/schema.js";
import {
  auditEvents,
  changeIntents,
  changes,
  classifications,
  diffs,
  evidence as evidenceTable,
  issues,
  pipelineRuns,
  planPicks,
  plans,
  principalKeys,
  principals,
  repoPolicies,
  repos,
  reviews,
  shadowSamples,
  tours,
} from "../db/schema.js";
import { guardUnclaimedRepoWrite } from "../limits/refusals.js";
import {
  changeFromRow,
  changeToRow,
  classificationFromJson,
  issueFromRow,
  type PlanView,
  parseRow,
  planFromRow,
  planToRow,
  planViewFromRow,
  principalFromRows,
  repoFromRow,
  repoToRow,
  reviewFromRow,
  runFromRow,
  StoreDataError,
} from "./rows.js";

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

/** JSON documents above this size are written to R2 and the row keeps a pointer. */
export const INLINE_JSON_LIMIT = 512 * 1024;

/** Statuses of changes that have not merged (or ended) yet: what lane counts are about. */
export const PRE_MERGE_STATUSES: Change["status"][] = [
  "awaiting-push",
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
];

export interface LaneCounts {
  lane0: number;
  lane1: number;
  lane2: number;
  awaitingReview: number;
  rollingOut: number;
  failing: number;
  /** Draft plans waiting for a human approval. */
  plansAwaitingApproval: number;
}

/** Name card for a principal id (the `principals` map on API responses). */
export interface PrincipalRef {
  id: string;
  name: string;
  kind: "human" | "agent" | "system" | "integration";
  ownerId: string | null;
  /** The accountable person's name (agents); null without an owner or when it is unknown. */
  ownerName: string | null;
}

export const EMPTY_LANE_COUNTS: LaneCounts = {
  lane0: 0,
  lane1: 0,
  lane2: 0,
  awaitingReview: 0,
  rollingOut: 0,
  failing: 0,
  plansAwaitingApproval: 0,
};

/** A person's pick among a plan's attempts (one per plan). */
export interface PlanPick {
  planId: string;
  changeId: string;
  pickedBy: string;
  headSha: string | null;
  pickedAt: string;
}

export interface ChangeSummary extends Change {
  planTitle: string | null;
  authorName: string;
  authorKind: "human" | "agent" | "system" | "integration";
}

export class NotFoundInStore extends Error {
  override readonly name = "NotFoundInStore";
}

type StoredJson = { json: string | null; r2Key: string | null; sizeBytes: number };

export class D1Store implements Store {
  readonly db: Db;

  constructor(
    d1: D1Database,
    private readonly blobs: R2Bucket,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = createDb(d1);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ------------------------------------------------------------ JSON blobs (inline or R2)

  private async putJson(r2Key: string, value: unknown): Promise<StoredJson> {
    const text = JSON.stringify(value);
    const sizeBytes = new TextEncoder().encode(text).byteLength;
    if (sizeBytes <= INLINE_JSON_LIMIT) return { json: text, r2Key: null, sizeBytes };
    await this.blobs.put(r2Key, text, { httpMetadata: { contentType: "application/json" } });
    return { json: null, r2Key, sizeBytes };
  }

  private async getJson(
    row: { json: string | null; r2Key: string | null },
    what: string,
  ): Promise<unknown> {
    let text = row.json;
    if (text === null && row.r2Key !== null) {
      const obj = await this.blobs.get(row.r2Key);
      if (!obj) throw new StoreDataError(`${what}: R2 object ${row.r2Key} is missing`);
      text = await obj.text();
    }
    if (text === null) throw new StoreDataError(`${what}: row has neither json nor r2_key`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new StoreDataError(`${what}: stored JSON does not parse`);
    }
  }

  // ------------------------------------------------------------ repos

  async getRepo(id: string): Promise<Repo | null> {
    const r = await this.db.select().from(repos).where(eq(repos.id, id)).get();
    return r ? repoFromRow(r) : null;
  }

  async getRepoByArtifactsName(artifactsName: string): Promise<Repo | null> {
    const r = await this.db
      .select()
      .from(repos)
      .where(eq(repos.artifactsName, artifactsName))
      .get();
    return r ? repoFromRow(r) : null;
  }

  async insertRepo(repo: Repo, createdBy: string | null = null): Promise<void> {
    // O3: an unclaimed repo never stores a deploy target, Lane 0 or revert auto-merge.
    const insert = this.db
      .insert(repos)
      .values(repoToRow(guardUnclaimedRepoWrite(repo), createdBy));
    // A claimed repo's owner is its first `owner` member, in the same batch (src/access/).
    const owner = repo.claim.status === "claimed" ? repo.claim.ownerId : null;
    if (owner === null || !(await isHumanPrincipal(this, owner))) await insert;
    else await this.db.batch([insert, ownerMembershipInsert(this, repo.id, owner, this.iso())]);
  }

  async updateRepo(id: string, patch: Partial<Omit<Repo, "id" | "createdAt">>): Promise<Repo> {
    const current = await this.getRepo(id);
    if (!current) throw new NotFoundInStore(`repo ${id} not found`);
    const next: Repo = guardUnclaimedRepoWrite({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
    });
    const { createdBy: _c, flagshipAppId, ...rest } = repoToRow(next);
    // The Flagship app is written by `setRepoFlagshipApp` (compare-and-set) or an explicit patch,
    // never as a side effect of another update that read the row before the app was recorded.
    const row = "flagshipAppId" in patch ? { ...rest, flagshipAppId } : rest;
    const update = this.db.update(repos).set(row).where(eq(repos.id, id));
    // Claiming (or any new claim owner) makes that human an `owner` member (src/access/).
    const owner = next.claim.status === "claimed" ? next.claim.ownerId : null;
    const newOwner =
      owner !== null && (current.claim.status !== "claimed" || current.claim.ownerId !== owner);
    if (!newOwner || !(await isHumanPrincipal(this, owner))) await update;
    else await this.db.batch([update, ownerMembershipInsert(this, id, owner, this.iso())]);
    return next;
  }

  async setRepoFlagshipApp(repoId: string, appId: string): Promise<string> {
    await this.db
      .update(repos)
      .set({ flagshipAppId: appId })
      .where(and(eq(repos.id, repoId), isNull(repos.flagshipAppId)));
    const r = await this.db
      .select({ flagshipAppId: repos.flagshipAppId })
      .from(repos)
      .where(eq(repos.id, repoId))
      .get();
    if (r === undefined) throw new NotFoundInStore(`repo ${repoId} not found`);
    if (r.flagshipAppId === null) throw new Error(`repo ${repoId}: Flagship app not recorded`);
    return r.flagshipAppId;
  }

  async setRepoPolicy(repoId: string, policy: RepoPolicy, sha: string): Promise<void> {
    await this.updateRepo(repoId, { policy, policySha: sha });
    await this.db
      .insert(repoPolicies)
      .values({ repoId, sha, policy, createdAt: this.iso() })
      .onConflictDoUpdate({ target: [repoPolicies.repoId, repoPolicies.sha], set: { policy } });
  }

  /** The policy evaluated from the default branch at `sha`, if the coordinator ever cached it. */
  async getRepoPolicyAt(repoId: string, sha: string): Promise<RepoPolicy | null> {
    const r = await this.db
      .select()
      .from(repoPolicies)
      .where(and(eq(repoPolicies.repoId, repoId), eq(repoPolicies.sha, sha)))
      .get();
    return r ? parseRow(RepoPolicy, r.policy, `policy ${repoId}@${sha}`) : null;
  }

  async listRepos(): Promise<Repo[]> {
    const rows = await this.db.select().from(repos).orderBy(asc(repos.name)).all();
    return rows.map(repoFromRow);
  }

  // ------------------------------------------------------------ plans

  async getPlan(id: string): Promise<Plan | null> {
    const r = await this.db.select().from(plans).where(eq(plans.id, id)).get();
    return r ? planFromRow(r) : null;
  }

  async getPlanView(id: string): Promise<PlanView | null> {
    const r = await this.db.select().from(plans).where(eq(plans.id, id)).get();
    return r ? planViewFromRow(r) : null;
  }

  async listPlanViews(repoId: string): Promise<PlanView[]> {
    const rows = await this.db
      .select()
      .from(plans)
      .where(eq(plans.repoId, repoId))
      .orderBy(desc(plans.createdAt))
      .all();
    return rows.map(planViewFromRow);
  }

  /** Draft plans per repo (awaiting a human approval). */
  async countDraftPlans(repoId?: string): Promise<Map<string, number>> {
    const where = repoId
      ? and(eq(plans.status, "draft"), eq(plans.repoId, repoId))
      : eq(plans.status, "draft");
    const rows = await this.db
      .select({ repoId: plans.repoId, n: sql<number>`count(*)` })
      .from(plans)
      .where(where)
      .groupBy(plans.repoId)
      .all();
    return new Map(rows.map((r) => [r.repoId, Number(r.n)]));
  }

  /** Key id that signed the plan's approval (not part of the domain Plan). */
  async getPlanApprovalKeyId(id: string): Promise<string | null> {
    const r = await this.db
      .select({ keyId: plans.approvalKeyId })
      .from(plans)
      .where(eq(plans.id, id))
      .get();
    return r?.keyId ?? null;
  }

  async insertPlan(plan: Plan): Promise<void> {
    await this.db.insert(plans).values(planToRow(plan, { updatedAt: plan.createdAt }));
  }

  /** Statement for `db.batch` (atomic multi-row plan transitions). */
  updatePlanStatement(
    plan: Plan,
    extra: {
      approvalKeyId?: string | null;
      decisionComment?: string | null;
      decidedBy?: string | null;
      decidedAt?: string | null;
    } = {},
  ) {
    const {
      id: _id,
      createdAt: _c,
      ...row
    } = planToRow(plan, {
      approvalKeyId: extra.approvalKeyId ?? null,
      updatedAt: this.iso(),
    });
    return this.db
      .update(plans)
      .set({
        ...row,
        ...(extra.decisionComment !== undefined ? { decisionComment: extra.decisionComment } : {}),
        ...(extra.decidedBy !== undefined ? { decidedBy: extra.decidedBy } : {}),
        ...(extra.decidedAt !== undefined ? { decidedAt: extra.decidedAt } : {}),
      })
      .where(eq(plans.id, plan.id));
  }

  async listPlans(repoId: string): Promise<Plan[]> {
    const rows = await this.db
      .select()
      .from(plans)
      .where(eq(plans.repoId, repoId))
      .orderBy(desc(plans.createdAt))
      .all();
    return rows.map(planFromRow);
  }

  // ------------------------------------------------------------ changes

  async getChange(id: string): Promise<Change | null> {
    const r = await this.db.select().from(changes).where(eq(changes.id, id)).get();
    return r ? changeFromRow(r) : null;
  }

  async getChangeByFork(forkName: string): Promise<Change | null> {
    const r = await this.db.select().from(changes).where(eq(changes.forkName, forkName)).get();
    return r ? changeFromRow(r) : null;
  }

  async getChangeByRolloutVersion(versionId: string): Promise<Change | null> {
    const r = await this.db
      .select()
      .from(changes)
      .where(eq(changes.rolloutVersionId, versionId))
      .orderBy(desc(changes.updatedAt))
      .get();
    return r ? changeFromRow(r) : null;
  }

  async insertChange(change: Change): Promise<void> {
    await this.db.insert(changes).values(changeToRow(change));
  }

  async updateChange(
    id: string,
    patch: Partial<Omit<Change, "id" | "repoId" | "createdAt">>,
  ): Promise<Change> {
    const current = await this.getChange(id);
    if (!current) throw new NotFoundInStore(`change ${id} not found`);
    const next: Change = {
      ...current,
      ...patch,
      id: current.id,
      repoId: current.repoId,
      createdAt: current.createdAt,
      updatedAt: this.iso(),
    };
    const { id: _id, repoId: _r, createdAt: _c, ...row } = changeToRow(next);
    await this.db.update(changes).set(row).where(eq(changes.id, id));
    return next;
  }

  async listChanges(repoId: string, statuses: Change["status"][]): Promise<Change[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select()
      .from(changes)
      .where(and(eq(changes.repoId, repoId), inArray(changes.status, statuses)))
      .orderBy(asc(changes.createdAt))
      .all();
    return rows.map(changeFromRow);
  }

  async listChangesForPlan(planId: string): Promise<Change[]> {
    const rows = await this.db
      .select()
      .from(changes)
      .where(eq(changes.planId, planId))
      .orderBy(desc(changes.createdAt))
      .all();
    return rows.map(changeFromRow);
  }

  /** Changes with plan title and author, newest activity first. */
  async listChangeSummaries(
    repoId: string,
    filter: { statuses?: Change["status"][]; lane?: Lane; limit?: number } = {},
  ): Promise<ChangeSummary[]> {
    // GitHub mode's backtest grades history as `ghb-*` Changes: never in the review lists.
    const where: SQL[] = [eq(changes.repoId, repoId), sql`${changes.id} NOT LIKE 'ghb-%'`];
    if (filter.statuses && filter.statuses.length > 0)
      where.push(inArray(changes.status, filter.statuses));
    if (filter.lane !== undefined) where.push(eq(changes.lane, filter.lane));
    const rows = await this.db
      .select({
        change: changes,
        planTitle: plans.title,
        authorName: principals.name,
        authorKind: principals.kind,
      })
      .from(changes)
      .leftJoin(plans, eq(plans.id, changes.planId))
      .leftJoin(principals, eq(principals.id, changes.authorId))
      .where(and(...where))
      .orderBy(desc(changes.updatedAt))
      .limit(Math.min(filter.limit ?? 200, 500))
      .all();
    return rows.map((r) => ({
      ...changeFromRow(r.change),
      planTitle: r.planTitle ?? null,
      authorName: r.authorName ?? r.change.authorId,
      authorKind: r.authorKind ?? "agent",
    }));
  }

  /** LaneCounts per repo id (repos without changes are absent). */
  async laneCounts(repoId?: string): Promise<Map<string, LaneCounts>> {
    const open = sql.join(
      PRE_MERGE_STATUSES.map((st) => sql`${st}`),
      sql`, `,
    );
    const q = this.db
      .select({
        repoId: changes.repoId,
        lane0: sql<number>`sum(case when ${changes.lane} = 0 and ${changes.status} in (${open}) then 1 else 0 end)`,
        lane1: sql<number>`sum(case when ${changes.lane} = 1 and ${changes.status} in (${open}) then 1 else 0 end)`,
        lane2: sql<number>`sum(case when ${changes.lane} = 2 and ${changes.status} in (${open}) then 1 else 0 end)`,
        awaitingReview: sql<number>`sum(case when ${changes.status} = 'awaiting-review' then 1 else 0 end)`,
        rollingOut: sql<number>`sum(case when ${changes.status} = 'rolling-out' then 1 else 0 end)`,
        failing: sql<number>`sum(case when ${changes.status} = 'failing' then 1 else 0 end)`,
      })
      .from(changes);
    const notBacktest = sql`${changes.id} NOT LIKE 'ghb-%'`;
    const rows = await (repoId
      ? q.where(and(eq(changes.repoId, repoId), notBacktest))
      : q.where(notBacktest)
    )
      .groupBy(changes.repoId)
      .all();
    const out = new Map<string, LaneCounts>();
    for (const r of rows) {
      out.set(r.repoId, {
        lane0: Number(r.lane0 ?? 0),
        lane1: Number(r.lane1 ?? 0),
        lane2: Number(r.lane2 ?? 0),
        awaitingReview: Number(r.awaitingReview ?? 0),
        rollingOut: Number(r.rollingOut ?? 0),
        failing: Number(r.failing ?? 0),
        plansAwaitingApproval: 0,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ runs

  async upsertRun(run: PipelineRun): Promise<void> {
    const v = PipelineRun.parse(run);
    const row = {
      id: v.id,
      changeId: v.changeId,
      headSha: v.headSha,
      engine: v.engine,
      status: v.status,
      startedAt: v.startedAt,
      finishedAt: v.finishedAt,
      steps: v.steps,
      updatedAt: this.iso(),
    };
    const { id: _id, ...set } = row;
    await this.db
      .insert(pipelineRuns)
      .values(row)
      .onConflictDoUpdate({ target: pipelineRuns.id, set });
  }

  async getRun(id: string): Promise<PipelineRun | null> {
    const r = await this.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).get();
    return r ? runFromRow(r) : null;
  }

  async listRuns(changeId: string, headSha?: string): Promise<PipelineRun[]> {
    const where = headSha
      ? and(eq(pipelineRuns.changeId, changeId), eq(pipelineRuns.headSha, headSha))
      : eq(pipelineRuns.changeId, changeId);
    const rows = await this.db
      .select()
      .from(pipelineRuns)
      .where(where)
      .orderBy(desc(pipelineRuns.startedAt), desc(pipelineRuns.updatedAt))
      .all();
    return rows.map(runFromRow);
  }

  // ------------------------------------------------------------ diffs

  async putDiff(changeId: string, diff: ChangeDiff): Promise<void> {
    const v = ChangeDiff.parse(diff);
    const stored = await this.putJson(`diffs/${changeId}/${v.headSha}.json`, v);
    const row = {
      changeId,
      headSha: v.headSha,
      baseSha: v.baseSha,
      ...stored,
      createdAt: this.iso(),
    };
    await this.db
      .insert(diffs)
      .values(row)
      .onConflictDoUpdate({
        target: [diffs.changeId, diffs.headSha],
        set: { baseSha: row.baseSha, json: row.json, r2Key: row.r2Key, sizeBytes: row.sizeBytes },
      });
  }

  async getDiff(changeId: string, headSha: string): Promise<ChangeDiff | null> {
    const r = await this.db
      .select()
      .from(diffs)
      .where(and(eq(diffs.changeId, changeId), eq(diffs.headSha, headSha)))
      .get();
    if (!r) return null;
    const what = `diff ${changeId}@${headSha}`;
    return parseRow(ChangeDiff, await this.getJson(r, what), what);
  }

  /**
   * The changed paths (and rename sources) of each change's diff at the given head, without
   * reading hunks: inline diffs are read with SQLite's JSON functions in one query; diffs kept in
   * R2 are fetched (at most `maxBlobReads`). A change missing from the result has no diff at that
   * head, or one this call didn't read: its paths are unknown.
   */
  async changedPathsAt(
    heads: ReadonlyArray<{ changeId: string; headSha: string }>,
    maxBlobReads = 5,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const want = new Map(heads.map((h) => [h.changeId, h.headSha]));
    const ids = [...want.keys()];
    const PathList = z.array(z.string().nullable());
    let blobReads = 0;
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rows = await this.db
        .select({
          changeId: diffs.changeId,
          headSha: diffs.headSha,
          r2Key: diffs.r2Key,
          // Qualified on purpose: json_each has a hidden column named `json` that would shadow it.
          paths: sql<string | null>`(SELECT json_group_array(p) FROM (
              SELECT json_extract(f.value, '$.path') AS p FROM json_each("diffs"."json", '$.files') AS f
              UNION
              SELECT json_extract(f.value, '$.previousPath') FROM json_each("diffs"."json", '$.files') AS f
              WHERE json_extract(f.value, '$.previousPath') IS NOT NULL))`,
        })
        .from(diffs)
        .where(inArray(diffs.changeId, chunk))
        .all();
      for (const r of rows) {
        if (want.get(r.changeId) !== r.headSha) continue;
        if (r.r2Key !== null) {
          if (blobReads >= maxBlobReads) continue;
          blobReads += 1;
          const diff = await this.getDiff(r.changeId, r.headSha).catch(() => null);
          if (diff === null) continue;
          out.set(r.changeId, [
            ...new Set(
              diff.files.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]),
            ),
          ]);
          continue;
        }
        let raw: unknown = null;
        try {
          raw = r.paths === null ? [] : JSON.parse(r.paths);
        } catch {
          continue; // unreadable: unknown, never "touches nothing"
        }
        const parsed = PathList.safeParse(raw);
        if (!parsed.success) continue;
        out.set(
          r.changeId,
          parsed.data.filter((p): p is string => typeof p === "string" && p.length > 0),
        );
      }
    }
    return out;
  }

  /**
   * The paths a change's author said it would touch at start_change (bounded to 50, as the
   * input). The first answer stands: a retried start doesn't rewrite it.
   */
  async putChangeIntent(changeId: string, paths: readonly string[]): Promise<void> {
    const bounded = [...new Set(paths.map((p) => p.trim()).filter((p) => p.length > 0))]
      .slice(0, 50)
      .map((p) => p.slice(0, 300));
    if (bounded.length === 0) return;
    await this.db
      .insert(changeIntents)
      .values({ changeId, paths: bounded, createdAt: this.iso() })
      .onConflictDoNothing()
      .run();
  }

  // ------------------------------------------------------------ attempts (plan picks)

  /** The attempt a person picked for a plan, if any (services/attempts.ts). */
  async getPlanPick(planId: string): Promise<PlanPick | null> {
    const r = await this.db.select().from(planPicks).where(eq(planPicks.planId, planId)).get();
    return r ?? null;
  }

  /**
   * Record a pick; the first one stands (a plan is picked once). Returns the stored pick, which
   * is another Change's when someone picked first.
   */
  async putPlanPick(pick: PlanPick): Promise<PlanPick> {
    await this.db.insert(planPicks).values(pick).onConflictDoNothing().run();
    const stored = await this.getPlanPick(pick.planId);
    if (stored === null) throw new Error(`plan pick for ${pick.planId} was not stored`);
    return stored;
  }

  /** Take back a pick whose approval failed (only that plan's pick of that change). */
  async deletePlanPick(planId: string, changeId: string): Promise<void> {
    await this.db
      .delete(planPicks)
      .where(and(eq(planPicks.planId, planId), eq(planPicks.changeId, changeId)))
      .run();
  }

  /** Stored intended paths of these changes; a change without any is absent. */
  async changeIntentsOf(changeIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const PathList = z.array(z.string()).max(50);
    const ids = [...new Set(changeIds)];
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await this.db
        .select()
        .from(changeIntents)
        .where(inArray(changeIntents.changeId, ids.slice(i, i + 90)))
        .all();
      for (const r of rows) {
        const parsed = PathList.safeParse(r.paths);
        if (parsed.success && parsed.data.length > 0) out.set(r.changeId, parsed.data);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ evidence

  async putEvidence(ev: Evidence): Promise<void> {
    const v = Evidence.parse(ev);
    const stored = await this.putJson(`evidence/${v.changeId}/${v.headSha}.json`, v);
    const row = {
      id: v.id,
      changeId: v.changeId,
      headSha: v.headSha,
      baseSha: v.baseSha,
      keyId: v.attestation.keyId,
      notesWritten: v.notesWritten,
      ...stored,
      createdAt: v.createdAt,
    };
    const { changeId: _c, headSha: _h, ...set } = row;
    await this.db
      .insert(evidenceTable)
      .values(row)
      .onConflictDoUpdate({ target: [evidenceTable.changeId, evidenceTable.headSha], set });
  }

  async getEvidence(changeId: string, headSha: string): Promise<Evidence | null> {
    const r = await this.db
      .select()
      .from(evidenceTable)
      .where(and(eq(evidenceTable.changeId, changeId), eq(evidenceTable.headSha, headSha)))
      .get();
    if (!r) return null;
    const what = `evidence ${changeId}@${headSha}`;
    return parseRow(Evidence, await this.getJson(r, what), what);
  }

  /**
   * Raw stored evidence JSON, unparsed. Signature verification must see exactly the stored bytes
   * (schema parsing strips unknown fields, which would hide injected content).
   */
  async getEvidenceRaw(changeId: string, headSha: string): Promise<unknown | null> {
    const r = await this.db
      .select()
      .from(evidenceTable)
      .where(and(eq(evidenceTable.changeId, changeId), eq(evidenceTable.headSha, headSha)))
      .get();
    return r ? this.getJson(r, `evidence ${changeId}@${headSha}`) : null;
  }

  // ------------------------------------------------------------ classifications

  async putClassification(
    changeId: string,
    headSha: string,
    result: ClassifyResult,
  ): Promise<void> {
    const v = classificationFromJson(result, `classification ${changeId}@${headSha}`);
    const row = {
      changeId,
      headSha,
      lane: v.lane,
      computedLane: v.computedLane,
      shadow: v.shadow,
      blocked: v.blocked,
      requiresHumanApproval: v.requiresHumanApproval,
      json: v,
      createdAt: this.iso(),
    };
    const { changeId: _c, headSha: _h, ...set } = row;
    await this.db
      .insert(classifications)
      .values(row)
      .onConflictDoUpdate({ target: [classifications.changeId, classifications.headSha], set });
  }

  async getClassification(changeId: string, headSha: string): Promise<ClassifyResult | null> {
    const r = await this.db
      .select()
      .from(classifications)
      .where(and(eq(classifications.changeId, changeId), eq(classifications.headSha, headSha)))
      .get();
    return r ? classificationFromJson(r.json, `classification ${changeId}@${headSha}`) : null;
  }

  // ------------------------------------------------------------ tours

  async putTour(tour: Tour): Promise<void> {
    const v = Tour.parse(tour);
    await this.db
      .insert(tours)
      .values({
        id: v.id,
        changeId: v.changeId,
        headSha: v.headSha,
        json: v,
        createdAt: v.createdAt,
      })
      .onConflictDoUpdate({ target: tours.id, set: { json: v } });
  }

  /** Latest tour for (change, head). */
  async getTour(changeId: string, headSha: string): Promise<Tour | null> {
    const r = await this.db
      .select()
      .from(tours)
      .where(and(eq(tours.changeId, changeId), eq(tours.headSha, headSha)))
      .orderBy(desc(tours.createdAt))
      .get();
    return r ? parseRow(Tour, r.json, `tour ${r.id}`) : null;
  }

  /** The most recent tour of a change, whatever head it was generated for. */
  async getLatestTour(changeId: string): Promise<Tour | null> {
    const r = await this.db
      .select()
      .from(tours)
      .where(eq(tours.changeId, changeId))
      .orderBy(desc(tours.createdAt))
      .get();
    return r ? parseRow(Tour, r.json, `tour ${r.id}`) : null;
  }

  async getTourById(id: string): Promise<Tour | null> {
    const r = await this.db.select().from(tours).where(eq(tours.id, id)).get();
    return r ? parseRow(Tour, r.json, `tour ${r.id}`) : null;
  }

  // ------------------------------------------------------------ reviews & shadow mode

  async putReview(review: ReviewDecision): Promise<void> {
    const v = ReviewDecision.parse(review);
    await this.db.insert(reviews).values({
      id: v.id,
      changeId: v.changeId,
      headSha: v.headSha,
      reviewerId: v.reviewerId,
      decision: v.decision,
      humanLane: v.humanLane,
      computedLane: v.computedLane,
      comment: v.comment,
      source: v.source ?? null,
      createdAt: v.createdAt,
    });
  }

  async withdrawReview(id: string, w: NonNullable<ReviewDecision["withdrawn"]>): Promise<void> {
    await this.db
      .update(reviews)
      .set({ withdrawnAt: w.at, withdrawnReason: w.reason, withdrawnBy: w.by })
      .where(eq(reviews.id, id));
  }

  async listReviews(changeId: string): Promise<ReviewDecision[]> {
    const rows = await this.db
      .select()
      .from(reviews)
      .where(eq(reviews.changeId, changeId))
      .orderBy(asc(reviews.createdAt))
      .all();
    return rows.map(reviewFromRow);
  }

  async listShadowSamples(repoId: string): Promise<ShadowSample[]> {
    const rows = await this.db
      .select()
      .from(shadowSamples)
      .where(and(eq(shadowSamples.repoId, repoId), eq(shadowSamples.computedLane, 0)))
      .orderBy(asc(shadowSamples.createdAt))
      .all();
    return rows.map((r) => shadowSampleFromRow(r));
  }

  /** Shadow samples for many repos in one query (repo list view). */
  async listShadowSamplesByRepo(): Promise<Map<string, ShadowSample[]>> {
    const rows = await this.db
      .select()
      .from(shadowSamples)
      .where(eq(shadowSamples.computedLane, 0))
      .all();
    const out = new Map<string, ShadowSample[]>();
    for (const r of rows) {
      const list = out.get(r.repoId) ?? [];
      list.push(shadowSampleFromRow(r));
      out.set(r.repoId, list);
    }
    return out;
  }

  // ------------------------------------------------------------ issues

  async putIssue(issue: LinkedIssue & { scriptName: string; raw: unknown }): Promise<void> {
    const row = {
      id: issue.id,
      changeId: issue.changeId,
      scriptName: issue.scriptName,
      title: issue.title,
      count: issue.count,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      versionId: issue.versionId,
      url: issue.url,
      raw: issue.raw ?? null,
      updatedAt: this.iso(),
    };
    const { id: _id, ...set } = row;
    await this.db
      .insert(issues)
      .values(row)
      .onConflictDoUpdate({
        target: issues.id,
        set: {
          ...set,
          // Keep the earliest first-seen and an attribution once known.
          firstSeen: sql`min(${issues.firstSeen}, excluded.first_seen)`,
          changeId: sql`coalesce(excluded.change_id, ${issues.changeId})`,
          versionId: sql`coalesce(excluded.version_id, ${issues.versionId})`,
        },
      });
  }

  async listIssues(filter: {
    versionId?: string;
    changeId?: string;
    since?: string;
  }): Promise<LinkedIssue[]> {
    const where: SQL[] = [];
    if (filter.versionId !== undefined) where.push(eq(issues.versionId, filter.versionId));
    if (filter.changeId !== undefined) where.push(eq(issues.changeId, filter.changeId));
    if (filter.since !== undefined) where.push(gte(issues.lastSeen, filter.since));
    const q = this.db.select().from(issues);
    const rows = await (where.length > 0 ? q.where(and(...where)) : q)
      .orderBy(desc(issues.lastSeen))
      .limit(500)
      .all();
    return rows.map(issueFromRow);
  }

  // ------------------------------------------------------------ principals

  async getPrincipal(id: string): Promise<Principal | null> {
    const r = await this.db.select().from(principals).where(eq(principals.id, id)).get();
    if (!r) return null;
    const keys = await this.db
      .select()
      .from(principalKeys)
      .where(eq(principalKeys.principalId, id))
      .all();
    return principalFromRows(r, keys);
  }

  /** `{ id → { id, name, kind, ownerId, ownerName } }` for the given ids (unknown ids are left out). */
  async principalRefs(ids: Iterable<string>): Promise<Record<string, PrincipalRef>> {
    const unique = [...new Set(ids)].filter((x) => x.length > 0);
    const out: Record<string, PrincipalRef> = {};
    for (let i = 0; i < unique.length; i += 90) {
      const chunk = unique.slice(i, i + 90);
      const rows = await this.db
        .select({
          id: principals.id,
          name: principals.name,
          kind: principals.kind,
          ownerId: principals.ownerId,
        })
        .from(principals)
        .where(inArray(principals.id, chunk))
        .all();
      for (const r of rows)
        out[r.id] = { id: r.id, name: r.name, kind: r.kind, ownerId: r.ownerId, ownerName: null };
    }
    // One more lookup names the owners (an agent row says whose it is) that weren't in `ids`.
    const owners = [
      ...new Set(Object.values(out).flatMap((p) => (p.ownerId === null ? [] : [p.ownerId]))),
    ];
    const names = new Map<string, string>();
    for (const o of owners) {
      const known = out[o];
      if (known !== undefined) names.set(o, known.name);
    }
    const missing = owners.filter((o) => !names.has(o));
    for (let i = 0; i < missing.length; i += 90) {
      const rows = await this.db
        .select({ id: principals.id, name: principals.name })
        .from(principals)
        .where(inArray(principals.id, missing.slice(i, i + 90)))
        .all();
      for (const r of rows) names.set(r.id, r.name);
    }
    for (const p of Object.values(out))
      if (p.ownerId !== null) p.ownerName = names.get(p.ownerId) ?? null;
    return out;
  }

  async getPrincipals(ids: string[]): Promise<Map<string, Principal>> {
    const out = new Map<string, Principal>();
    if (ids.length === 0) return out;
    const unique = [...new Set(ids)];
    const rows = await this.db
      .select()
      .from(principals)
      .where(inArray(principals.id, unique))
      .all();
    const keys = await this.db
      .select()
      .from(principalKeys)
      .where(inArray(principalKeys.principalId, unique))
      .all();
    for (const r of rows) {
      out.set(
        r.id,
        principalFromRows(
          r,
          keys.filter((k) => k.principalId === r.id),
        ),
      );
    }
    return out;
  }

  // ------------------------------------------------------------ audit mirror (read side)

  /** Newest first. `beforeSeq` is the cursor (exclusive). */
  async listAuditEvents(filter: {
    log: string;
    subject?: string;
    /** Exact principal id (indexed: audit_events_principal_seq_idx). */
    actor?: string;
    /** Exact action (indexed: audit_events_action_seq_idx). */
    action?: string;
    beforeSeq?: number;
    limit: number;
    /** Extra condition (src/access/audit.ts: the events a principal may read). */
    visible?: SQL;
  }): Promise<AuditEvent[]> {
    const where: SQL[] = [eq(auditEvents.log, filter.log)];
    if (filter.visible !== undefined) where.push(filter.visible);
    if (filter.subject !== undefined) where.push(eq(auditEvents.subject, filter.subject));
    if (filter.actor !== undefined) where.push(eq(auditEvents.principalId, filter.actor));
    if (filter.action !== undefined) where.push(eq(auditEvents.action, filter.action));
    if (filter.beforeSeq !== undefined) where.push(lt(auditEvents.seq, filter.beforeSeq));
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(...where))
      .orderBy(desc(auditEvents.seq))
      .limit(filter.limit)
      .all();
    return rows.map(auditFromRow);
  }

  /** Oldest first: a subject's timeline (e.g. a change's rollout). */
  async auditTimeline(log: string, subject: string, limit = 500): Promise<AuditEvent[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.log, log), eq(auditEvents.subject, subject)))
      .orderBy(asc(auditEvents.seq))
      .limit(limit)
      .all();
    return rows.map(auditFromRow);
  }

  /** Mirror rows by seq (with payloads), for re-verifying a page. */
  async auditPayloads(log: string, seqs: number[]): Promise<Map<number, unknown>> {
    const out = new Map<number, unknown>();
    // Chunked: D1 binds at most 100 parameters per query, and a page can be 200 events.
    for (let i = 0; i < seqs.length; i += 90) {
      const rows = await this.db
        .select({ seq: auditEvents.seq, payload: auditEvents.payload })
        .from(auditEvents)
        .where(and(eq(auditEvents.log, log), inArray(auditEvents.seq, seqs.slice(i, i + 90))))
        .all();
      for (const r of rows) out.set(r.seq, r.payload ?? null);
    }
    return out;
  }
}

// ---------------------------------------------------------------- helpers

const AuditRow = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  principalId: z.string(),
  action: z.string(),
  subject: z.string(),
  payloadHash: z.string(),
  prevHash: z.string(),
  hash: z.string(),
  signature: z.string(),
  keyId: z.string(),
});

function auditFromRow(r: typeof auditEvents.$inferSelect): AuditEvent {
  return parseRow(
    AuditRow,
    {
      seq: r.seq,
      at: r.at,
      principalId: r.principalId,
      action: r.action,
      subject: r.subject,
      payloadHash: r.payloadHash,
      prevHash: r.prevHash,
      hash: r.hash,
      signature: r.signature,
      keyId: r.keyId,
    },
    `audit event ${r.seq}`,
  );
}

const ShadowRow = z.object({
  computedLane: Lane,
  humanLane: Lane.nullable(),
  decision: z.enum(["approve", "request-changes", "reject"]),
});

function shadowSampleFromRow(r: {
  computedLane: number;
  humanLane: number | null;
  decision: string;
}): ShadowSample {
  return parseRow(ShadowRow, r, "shadow sample");
}
