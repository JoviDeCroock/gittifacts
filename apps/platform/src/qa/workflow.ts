/**
 * `QaRunWorkflow`: one instance per QA run (src/qa/request.ts starts it).
 *
 *   load → boot (private preview of the head) → drive (Browser Run + the agent loop, artifacts to
 *   R2) → finish (signed item into the head's bundle, lane raised if QA says so, the row) →
 *   notify → publish (GitHub: check run + summary comment) → stop the private preview.
 *
 * The browser step is retried at most once (a browser session is the expensive part); a run that
 * can't drive the app ends with a `qa-run` item of status "error", which raises the lane to 1
 * (unknown → escalate) like any errored signal.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { isTemplateId, TEMPLATES } from "@app/conventions";
import { resolveRuntime } from "@app/coordinator";
import type { QaRun } from "@app/evidence";
import { criteriaFor, routesFor, runQa } from "@app/qa";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import type { Bindings } from "../app-env.js";
import { D1Store } from "../store/d1-store.js";
import { finishQaRun, publishQaOnGithub, type QaFinish } from "./finish.js";
import { appFetchFor, previewStub, privatePreviewId, qaOrigin, qaRuntime } from "./runtime.js";
import { QaStore } from "./store.js";

const Params = z.object({ runId: z.string().min(1).max(100) });
const QUICK = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;
const BOOT = { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" } as const;
const DRIVE = { retries: { limit: 1, delay: "15 seconds" }, timeout: "10 minutes" } as const;
const MAX_LLM_USD = 0.05;

interface Loaded {
  changeId: string;
  repoId: string;
  headSha: string;
  title: string;
  trigger: QaRun["trigger"];
  requestedBy: string;
  criteria: ReturnType<typeof criteriaFor>;
  routes: string[];
  changedFiles: string[];
  snapshotId: string | null;
  snapshotStep: "build" | "install";
  artifactsRepo: string;
  template: string | null;
  claimed: boolean;
  projectName: string;
  policyModel: string;
  llmUsd: number;
}

export class QaRunWorkflow extends WorkflowEntrypoint<Bindings, unknown> {
  override async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<{ status: string }> {
    const { runId } = Params.parse(event.payload);
    const env = this.env;
    const qa = new QaStore(drizzle(env.DB));
    const progress = (line: string, extra: Record<string, unknown> = {}) =>
      qa.update(runId, { progress: line, ...extra });

    let ctx: Loaded;
    try {
      ctx = await step.do("load", QUICK, async (): Promise<Loaded> => {
        const row = await qa.get(runId);
        if (row === null) throw new Error(`qa run ${runId} not found`);
        const { ports, bindings } = resolveRuntime(env, "default");
        const store = ports.store;
        const [change, repo] = await Promise.all([
          store.getChange(row.changeId),
          store.getRepo(row.repoId),
        ]);
        if (change === null || repo === null) throw new Error("the change or its repo is gone");
        const [plan, diff] = await Promise.all([
          change.planId === null ? null : store.getPlan(change.planId),
          store.getDiff(row.changeId, row.headSha),
        ]);
        const passed = (
          await new D1Store(env.DB, env.BLOBS).listRuns(row.changeId, row.headSha)
        ).find((r) => r.status === "passed");
        const status =
          passed === undefined
            ? null
            : ((await ports.ci.status(passed.id).catch(() => null)) as {
                snapshots?: Record<string, string>;
              } | null);
        const snapshots = status?.snapshots ?? {};
        const step: "build" | "install" = snapshots.build !== undefined ? "build" : "install";
        const changedFiles = (diff?.files ?? []).map((f) => f.path).slice(0, 200);
        const templateRoutes =
          repo.template !== null && isTemplateId(repo.template)
            ? [...TEMPLATES[repo.template].manifest.routes]
            : [];
        const spent = await bindings
          .changeCoordinator(row.changeId)
          .spent(row.changeId)
          .catch(() => 0);
        await progress("starting the app", {
          status: "running",
          startedAt: new Date().toISOString(),
        });
        return {
          changeId: row.changeId,
          repoId: row.repoId,
          headSha: row.headSha,
          title: change.title,
          trigger: row.trigger,
          requestedBy: row.requestedBy,
          criteria: criteriaFor(plan),
          routes: routesFor({
            planRoutes: plan?.affectedRoutes ?? [],
            templateRoutes,
            changedFiles,
          }),
          changedFiles,
          snapshotId: snapshots[step] ?? null,
          snapshotStep: step,
          artifactsRepo: change.forkName,
          template: repo.template,
          claimed: repo.claim.status === "claimed",
          projectName: repo.name.slice(0, 100),
          policyModel: repo.policy.ai.reviewerModel,
          llmUsd: Math.max(0, Math.min(MAX_LLM_USD, repo.policy.ai.budgetUsdPerChange - spent)),
        };
      });
    } catch (e) {
      const error = `QA could not start: ${(e as Error).message}`.slice(0, 2000);
      await step.do("load-failed", QUICK, async () => {
        await qa.update(runId, {
          status: "failed",
          progress: null,
          error,
          finishedAt: new Date().toISOString(),
        });
        return true;
      });
      return { status: "failed" };
    }

    const previewId = privatePreviewId(ctx.changeId, ctx.headSha);
    const origin = qaOrigin(env, previewId);
    let item: QaRun;
    try {
      if (
        ctx.template !== null &&
        isTemplateId(ctx.template) &&
        TEMPLATES[ctx.template].manifest.previewCommand === null
      )
        throw new Error(`nothing to preview: the ${ctx.template} template has no app to serve`);
      if (ctx.snapshotId === null)
        throw new Error("CI left no build (or install) snapshot of this head to serve");
      const snapshotId = ctx.snapshotId;
      await step.do("boot", BOOT, async () => {
        const state = await previewStub(env, previewId).ensure(
          {
            previewId,
            changeId: ctx.changeId,
            repoId: ctx.repoId,
            projectName: ctx.projectName,
            headSha: ctx.headSha,
            artifactsRepo: ctx.artifactsRepo,
            snapshotId,
            snapshotStep: ctx.snapshotStep,
            template: ctx.template,
            claimed: ctx.claimed,
          },
          { waitMs: 150_000 },
        );
        if (state.status !== "ready")
          throw new Error(`the app did not start: ${state.detail ?? state.status}`);
        await progress(`testing ${ctx.criteria.length} criteria`);
        return true;
      });
      item = (await step.do("drive", DRIVE, async () =>
        drive(env, ctx, runId, previewId, origin, progress),
      )) as QaRun;
    } catch (e) {
      item = errored(ctx, runId, origin, e);
    }

    const finished = (await step.do("finish", QUICK, async () =>
      finishQaRun(env, runId, item),
    )) as QaFinish;
    await step.do("publish", QUICK, async () => {
      await publishQaOnGithub(env, finished).catch((e: unknown) =>
        console.warn("qa: GitHub publish failed", runId, e),
      );
      return true;
    });
    await step.do("stop-app", QUICK, async () => {
      await previewStub(env, previewId)
        .destroy?.()
        .catch(() => undefined);
      return true;
    });
    return { status: item.status };
  }
}

async function drive(
  env: Bindings,
  ctx: Loaded,
  runId: string,
  previewId: string,
  origin: string,
  progress: (l: string) => Promise<void>,
): Promise<QaRun> {
  const rt = qaRuntime();
  const browser = await rt.browser(env, origin, appFetchFor(env, previewId));
  try {
    const started = Date.now();
    return await runQa(
      {
        runId,
        trigger: ctx.trigger,
        requestedBy: ctx.requestedBy,
        origin,
        snapshotStep: ctx.snapshotStep,
        criteria: ctx.criteria,
        routes: ctx.routes,
        changedFiles: ctx.changedFiles,
        limits: { llmUsd: ctx.llmUsd },
      },
      {
        browser,
        llm: ctx.llmUsd > 0 ? rt.llm(env, ctx.policyModel) : null,
        artifacts: r2Sink(env, ctx.changeId, runId),
        now: () => Date.now(),
        metadata: { change_id: ctx.changeId, repo: ctx.repoId, qa_run: runId },
        log: (event, data) => {
          if (event === "qa.criterion")
            void progress(
              `criterion ${Number(data.index) + 1} of ${ctx.criteria.length}: ${String(data.verdict)}`,
            );
          console.log(JSON.stringify({ qa: event, runId, ms: Date.now() - started, ...data }));
        },
      },
    );
  } finally {
    await browser.close();
  }
}

function r2Sink(env: Bindings, changeId: string, runId: string) {
  return {
    put: async (
      name: string,
      bytes: Uint8Array,
      contentType: string,
      role: QaRun["artifacts"][number]["role"],
    ) => {
      const ref = `qa/${changeId}/${runId}/${name}`;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      await env.BLOBS.put(ref, bytes, {
        httpMetadata: { contentType },
        customMetadata: { changeId, runId, sha256 },
      });
      return { name, ref, sha256, bytes: bytes.byteLength, contentType, role };
    },
  };
}

function errored(ctx: Loaded, runId: string, origin: string, e: unknown): QaRun {
  const why = (e instanceof Error ? e.message : String(e)).slice(0, 3000);
  return {
    id: "qa-run",
    kind: "qa-run",
    // A repo with no app at all (a library) is not an unknown about this change: nothing to test.
    status: /nothing to preview/.test(why) ? "skipped" : "error",
    note: /nothing to preview/.test(why)
      ? `nothing to test in a browser: ${why}`
      : `QA could not run: ${why}`,
    runId,
    trigger: ctx.trigger,
    requestedBy: ctx.requestedBy,
    app: { source: "private-preview", snapshotStep: ctx.snapshotStep, origin },
    model: "none",
    promptVersion: "qa/1",
    criteria: [],
    artifacts: [],
    blockedOrigins: [],
    usage: { wallMs: 0, browserMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, llmUsd: 0 },
  };
}
