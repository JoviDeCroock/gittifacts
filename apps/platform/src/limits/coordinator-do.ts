/**
 * The platform's `ChangeCoordinator` Durable Object: the coordinator's class plus one hook. The
 * CI engine reports every finished run here (`onRunFinished`, the run sink); before the summary
 * goes on to the ChangeWorkflow, an unclaimed project's CI-minute reservation is settled to what
 * the run actually used and the bytes it stored (logs, build artifacts) are added to its storage
 * quota (src/limits/quotas.ts). Runs that were never metered (claimed projects) are untouched.
 */
import { ChangeCoordinator as CoordinatorChangeCoordinator } from "@app/coordinator/workers";
import { z } from "zod";
import { D1Store } from "../store/d1-store.js";
import { ledgersFor, type QuotaEnv } from "./quotas.js";

const Usage = z.object({
  id: z.string().min(1),
  changeId: z.string().min(1),
  usage: z
    .object({
      ciMinutes: z.number().nonnegative().catch(0),
      logBytes: z.number().nonnegative().catch(0),
      artifactBytes: z.number().nonnegative().catch(0),
    })
    .partial()
    .optional(),
});

type SettleEnv = QuotaEnv & { DB: D1Database; BLOBS: R2Bucket };

/** Settle a finished run against the ledgers of its (unclaimed) project. Never throws. */
export async function settleRunUsage(env: SettleEnv, summary: unknown, atMs = Date.now()) {
  const parsed = Usage.safeParse(summary);
  if (!parsed.success) return;
  const { id, changeId, usage } = parsed.data;
  try {
    const store = new D1Store(env.DB, env.BLOBS);
    const change = await store.getChange(changeId);
    if (change === null) return;
    const { project, ip } = await ledgersFor(env, store, change.repoId);
    const actualMinutes = usage?.ciMinutes ?? 0;
    // Only runs that were reserved (unclaimed at start) are settled and counted.
    const metered = await project.settleCi({ runId: id, actualMinutes });
    if (!metered) return;
    if (ip !== null) await ip.settleCi({ runId: id, actualMinutes });
    const bytes = (usage?.logBytes ?? 0) + (usage?.artifactBytes ?? 0);
    if (bytes > 0) {
      await project.add({ metric: "storage-bytes", amount: bytes, period: "total", atMs });
      if (ip !== null)
        await ip.add({ metric: "storage-bytes", amount: bytes, period: "total", atMs });
    }
  } catch (e) {
    console.error("could not settle CI usage for run", id, e);
  }
}

export class ChangeCoordinator extends CoordinatorChangeCoordinator {
  override async onRunFinished(summary: unknown) {
    await settleRunUsage(this.env as SettleEnv, summary);
    return super.onRunFinished(summary);
  }
}
