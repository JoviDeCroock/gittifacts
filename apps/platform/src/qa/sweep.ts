/**
 * QA runs never hang (the 10-minute cron, src/index.ts): a run still queued or running
 * `QA_STALE_MS` after it was asked lost its workflow (a deploy, an instance that ran elsewhere).
 * It ends as failed with the reason, the humans get the same `qa-finished` notice a finished run
 * sends, and the head can be asked again. Idempotent: only rows still in flight are touched.
 */
import { and, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type QaRunRow, qaRuns } from "../db/qa-schema.js";
import { D1Notifier } from "../notifier.js";
import { D1Store } from "../store/d1-store.js";
import { QaStore } from "./store.js";

/** A queued or running run older than this lost its workflow (the run's own budget is 5 min). */
export const QA_STALE_MS = 15 * 60_000;

export function lostReason(row: Pick<QaRunRow, "startedAt">): string {
  return row.startedAt === null
    ? `the run never started (no workflow picked it up within ${QA_STALE_MS / 60_000} minutes); ask again`
    : `the run stopped without a result (nothing for ${QA_STALE_MS / 60_000} minutes); ask again`;
}

/** End one stale run: failed, with why, and a notification. Returns false if it already ended. */
export async function endLostRun(
  env: { DB: D1Database; BLOBS: R2Bucket },
  row: QaRunRow,
  now: Date,
): Promise<boolean> {
  const qa = new QaStore(drizzle(env.DB));
  const fresh = await qa.get(row.id);
  if (fresh === null || (fresh.status !== "queued" && fresh.status !== "running")) return false;
  const error = lostReason(fresh);
  await qa.update(row.id, {
    status: "failed",
    progress: null,
    error,
    finishedAt: now.toISOString(),
  });
  const store = new D1Store(env.DB, env.BLOBS, () => now);
  const change = await store.getChange(row.changeId);
  await new D1Notifier(store, () => now).notify({
    kind: "qa-finished",
    changeId: row.changeId,
    repoId: row.repoId,
    message: `QA could not run on ${change?.title ?? row.changeId} at ${row.headSha.slice(0, 12)}: ${error}.`,
  });
  return true;
}

export async function runQaSweep(
  env: { DB: D1Database; BLOBS: R2Bucket },
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - QA_STALE_MS).toISOString();
  const stale = await drizzle(env.DB)
    .select()
    .from(qaRuns)
    .where(and(inArray(qaRuns.status, ["queued", "running"]), lt(qaRuns.createdAt, cutoff)))
    .limit(50)
    .all();
  let ended = 0;
  for (const row of stale) if (await endLostRun(env, row, now)) ended++;
  if (ended > 0) console.log(JSON.stringify({ qaSweep: { ended } }));
  return ended;
}
