/** `qa_runs` reads and writes, and the run's API view. */
import { QaRun } from "@app/evidence";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { type QaRunRow, qaRuns } from "../db/qa-schema.js";

export interface QaRunView {
  id: string;
  changeId: string;
  repoId: string;
  headSha: string;
  status: QaRunRow["status"];
  trigger: QaRunRow["trigger"];
  requestedBy: string;
  requestedLogin: string | null;
  progress: string | null;
  summary: { passed: number; failed: number; couldntTest: number } | null;
  laneBefore: number | null;
  laneAfter: number | null;
  costUsd: number | null;
  wallMs: number | null;
  error: string | null;
  /** Approvals this run withdrew (a failed criterion after approval). */
  withdrawn: Array<{ reviewId: string; reviewerId: string; name: string }>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The signed item's content (criteria, steps, artifacts), once done. */
  report: QaRun | null;
}

export function viewOf(r: QaRunRow): QaRunView {
  const report = r.item === null ? null : QaRun.safeParse(r.item);
  return {
    id: r.id,
    changeId: r.changeId,
    repoId: r.repoId,
    headSha: r.headSha,
    status: r.status,
    trigger: r.trigger,
    requestedBy: r.requestedBy,
    requestedLogin: r.requestedLogin,
    progress: r.progress,
    summary:
      r.passed === null
        ? null
        : { passed: r.passed, failed: r.failed ?? 0, couldntTest: r.couldntTest ?? 0 },
    laneBefore: r.laneBefore,
    laneAfter: r.laneAfter,
    costUsd: r.costUsd,
    wallMs: r.wallMs,
    error: r.error,
    withdrawn: r.withdrawn ?? [],
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    report: report?.success ? report.data : null,
  };
}

export class QaStore {
  constructor(readonly db: DrizzleD1Database) {}

  async get(id: string): Promise<QaRunRow | null> {
    return (await this.db.select().from(qaRuns).where(eq(qaRuns.id, id)).get()) ?? null;
  }

  async insert(row: typeof qaRuns.$inferInsert): Promise<void> {
    await this.db.insert(qaRuns).values(row);
  }

  async update(id: string, patch: Partial<typeof qaRuns.$inferInsert>): Promise<void> {
    await this.db.update(qaRuns).set(patch).where(eq(qaRuns.id, id));
  }

  /** Runs of a change, newest first. */
  async forChange(changeId: string, limit = 20): Promise<QaRunRow[]> {
    return this.db
      .select()
      .from(qaRuns)
      .where(eq(qaRuns.changeId, changeId))
      .orderBy(desc(qaRuns.createdAt))
      .limit(limit)
      .all();
  }

  /** The newest run of (change, head), if any. */
  async forHead(changeId: string, headSha: string): Promise<QaRunRow | null> {
    const row = await this.db
      .select()
      .from(qaRuns)
      .where(and(eq(qaRuns.changeId, changeId), eq(qaRuns.headSha, headSha)))
      .orderBy(desc(qaRuns.createdAt))
      .get();
    return row ?? null;
  }

  /** A run of this change still queued or running. */
  async inFlight(changeId: string): Promise<QaRunRow | null> {
    const row = await this.db
      .select()
      .from(qaRuns)
      .where(and(eq(qaRuns.changeId, changeId), inArray(qaRuns.status, ["queued", "running"])))
      .orderBy(desc(qaRuns.createdAt))
      .get();
    return row ?? null;
  }

  /** Runs requested for a repo since `sinceIso`, oldest first (the rate limit). */
  async repoSince(repoId: string, sinceIso: string): Promise<Array<{ createdAt: string }>> {
    return this.db
      .select({ createdAt: qaRuns.createdAt })
      .from(qaRuns)
      .where(and(eq(qaRuns.repoId, repoId), gte(qaRuns.createdAt, sinceIso)))
      .orderBy(qaRuns.createdAt)
      .all();
  }
}
