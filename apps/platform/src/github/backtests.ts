/**
 * M4: starting backtests and reading their results (no Workflow code here, so routes and services
 * can import it). The Workflow itself is ./backtest.ts.
 */
import type { BacktestReport } from "@app/host-github";
import { repoIdFor } from "@app/host-github";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Bindings } from "../app-env.js";
import { githubBacktests } from "../db/github-schema.js";
import { D1Store, type Db } from "../store/d1-store.js";
import { repoAllowed } from "./allowlist.js";

export const BacktestParams = z.object({
  backtestId: z.string().min(1).max(100),
  installationId: z.number().int().positive(),
  appId: z.number().int().positive(),
  githubRepoId: z.number().int().positive(),
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
});
export type BacktestParams = z.infer<typeof BacktestParams>;

/** Default window and size: 90 days, the newest 24 settled PRs (≈ 15 minutes in waves of 4). */
export const BACKTEST_DEFAULTS = { days: 90, maxPrs: 24 } as const;
/** On install, backtest at most this many of the installation's repos (the rest: on demand). */
export const AUTO_REPOS = 3;

interface WorkflowBinding {
  create(input: { id: string; params: BacktestParams }): Promise<unknown>;
}

/** The repo is outside GITHUB_REPO_ALLOWLIST. */
export class RepoNotAllowed extends Error {
  constructor(readonly fullName: string) {
    super(`${fullName} is outside GITHUB_REPO_ALLOWLIST`);
    this.name = "RepoNotAllowed";
  }
}

export async function startBacktest(
  env: Bindings,
  input: Omit<BacktestParams, "backtestId"> & { by: string; days?: number; maxPrs?: number },
): Promise<{ id: string; started: boolean }> {
  if (!repoAllowed(env as unknown as Record<string, unknown>, input.fullName))
    throw new RepoNotAllowed(input.fullName);
  const db = new D1Store(env.DB, env.BLOBS).db;
  const repoId = repoIdFor(input.githubRepoId);
  const running = await db
    .select({ id: githubBacktests.id, createdAt: githubBacktests.createdAt })
    .from(githubBacktests)
    .where(and(eq(githubBacktests.repoId, repoId), eq(githubBacktests.status, "running")))
    .get();
  if (running !== undefined && Date.now() - Date.parse(running.createdAt) < 2 * 3_600_000)
    return { id: running.id, started: false };
  const now = new Date();
  const id = `bt-${input.githubRepoId}-${now.getTime().toString(36)}`;
  await db.insert(githubBacktests).values({
    id,
    repoId,
    githubRepoId: input.githubRepoId,
    installationId: input.installationId,
    status: "running",
    since: new Date(
      now.getTime() - (input.days ?? BACKTEST_DEFAULTS.days) * 86_400_000,
    ).toISOString(),
    until: now.toISOString(),
    maxPrs: input.maxPrs ?? BACKTEST_DEFAULTS.maxPrs,
    startedBy: input.by,
    createdAt: now.toISOString(),
  });
  const wf = (env as unknown as { GITHUB_BACKTEST_WORKFLOW?: WorkflowBinding })
    .GITHUB_BACKTEST_WORKFLOW;
  if (wf === undefined) throw new Error("GITHUB_BACKTEST_WORKFLOW is not bound");
  await wf.create({
    id,
    params: {
      backtestId: id,
      installationId: input.installationId,
      appId: input.appId,
      githubRepoId: input.githubRepoId,
      fullName: input.fullName,
    },
  });
  return { id, started: true };
}

export async function latestBacktest(db: Db, repoId: string) {
  return (
    (await db
      .select()
      .from(githubBacktests)
      .where(eq(githubBacktests.repoId, repoId))
      .orderBy(desc(githubBacktests.createdAt))
      .get()) ?? null
  );
}

/** Lane 0 may be turned on for a GitHub repo only after a backtest found it calibrated. */
export async function calibrated(
  db: Db,
  repoId: string,
): Promise<{ eligible: boolean; reason: string }> {
  const done = await db
    .select({ eligible: githubBacktests.eligible, report: githubBacktests.report })
    .from(githubBacktests)
    .where(and(eq(githubBacktests.repoId, repoId), eq(githubBacktests.status, "done")))
    .orderBy(desc(githubBacktests.createdAt))
    .get();
  if (done === undefined)
    return { eligible: false, reason: "no backtest has finished for this repository yet" };
  const reason = (done.report as BacktestReport | null)?.calibration.reason ?? "unknown";
  return { eligible: done.eligible === true, reason };
}
