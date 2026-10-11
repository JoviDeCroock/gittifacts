/**
 * M4: the backtest of a GitHub repo (spec §3.7) as a durable Workflow (one instance per backtest):
 * `runBacktest` (packages/host-github) with each step a workflow step and each poll a workflow
 * sleep, then the report and the calibration are saved. Starting one: ./backtests.ts.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { resolveRuntime } from "@app/coordinator";
import type { GithubRepoHost } from "@app/domain";
import { GithubRepo, GithubSync, repoIdFor, runBacktest } from "@app/host-github";
import { eq } from "drizzle-orm";
import type { Bindings } from "../app-env.js";
import { githubBacktests } from "../db/github-schema.js";
import { D1Store } from "../store/d1-store.js";
import { BacktestParams } from "./backtests.js";
import { ensureGithubPrincipal, grantInstallationMembers } from "./grading.js";
import { githubActorPrincipal } from "./plans.js";
import { githubHostFor, githubReadSource } from "./runtime.js";

const STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

export class GithubBacktestWorkflow extends WorkflowEntrypoint<Bindings, unknown> {
  override async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<{ status: string }> {
    const p = BacktestParams.parse(event.payload);
    const env = this.env;
    const { ports, bindings } = resolveRuntime(env, "github");
    const store = new D1Store(env.DB, env.BLOBS);
    const row = await step.do("load", STEP, async () => {
      const r = await store.db
        .select()
        .from(githubBacktests)
        .where(eq(githubBacktests.id, p.backtestId))
        .get();
      if (r === undefined) throw new Error(`backtest ${p.backtestId} not found`);
      return { since: r.since, until: r.until, maxPrs: r.maxPrs };
    });
    const [owner = "", name = ""] = p.fullName.split("/");
    let repoHost: GithubRepoHost = {
      kind: "github",
      owner,
      repo: name,
      githubRepoId: p.githubRepoId,
      installationId: p.installationId,
      appId: p.appId,
      private: true,
    };
    const { host, api, release } = githubHostFor(env, ports, repoHost);
    try {
      // The repo row and mirror (a repo nobody opened a PR on yet is created here).
      await step.do("repo", STEP, async () => {
        if ((await ports.store.getRepo(repoIdFor(p.githubRepoId))) !== null) return true;
        const gh = GithubRepo.parse(await api.get(`/repos/${p.fullName}`));
        const sync = new GithubSync({
          ports,
          coordinator: (id) => bindings.changeCoordinator(id),
          host,
          installationId: p.installationId,
          appId: p.appId,
          source: () => githubReadSource(env, repoHost),
          authorPrincipal: (who) => ensureGithubPrincipal(store, who),
          onRepoCreated: (repo) => grantInstallationMembers(store, repo, p.installationId),
        });
        await sync.ensureRepo(gh);
        return true;
      });
      const repo = await ports.store.getRepo(repoIdFor(p.githubRepoId));
      if (repo?.host == null) throw new Error("the repository could not be mirrored");
      repoHost = repo.host;
      const report = await runBacktest(
        {
          ports,
          api,
          repo,
          coordinator: (id) => bindings.changeCoordinator(id),
          source: () => githubReadSource(env, repoHost),
          authorPrincipal: (who) => githubActorPrincipal(store, who),
          step: <T>(stepName: string, fn: () => Promise<T>) =>
            step.do(stepName, STEP, async () => (await fn()) as Rpc.Serializable<T>) as Promise<T>,
          sleep: (stepName, ms) => step.sleep(stepName, ms),
        },
        { since: row.since, until: row.until, maxPrs: row.maxPrs },
      );
      await step.do("save", STEP, async () => {
        await store.db
          .update(githubBacktests)
          .set({
            status: "done",
            report,
            eligible: report.calibration.eligible,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(githubBacktests.id, p.backtestId));
        await ports.audit.append({
          principalId: "system",
          action: "github.backtest-done",
          subject: `repo:${repo.id}`,
          payload: {
            backtestId: p.backtestId,
            graded: report.graded,
            wouldAutoMerge: report.wouldAutoMerge,
            calibration: report.calibration,
          },
        });
        return true;
      });
      return { status: "done" };
    } catch (e) {
      const error = (e as Error).message.slice(0, 2000);
      await step.do("failed", STEP, async () => {
        await store.db
          .update(githubBacktests)
          .set({ status: "failed", error, finishedAt: new Date().toISOString() })
          .where(eq(githubBacktests.id, p.backtestId));
        return true;
      });
      return { status: "failed" };
    } finally {
      await release();
    }
  }
}
