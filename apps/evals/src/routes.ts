/**
 * The evals Worker's HTTP API.
 *
 *   POST /runs                    start a matrix (EVALS_API_TOKEN)         → 202 { matrixId, runIds }
 *   GET  /runs/:id                a run's result, or its Workflow status   (read token)
 *   GET  /runs/:id/transcript     the run's redacted transcript            (read token)
 *   GET  /matrices                matrix ids, newest first                 (read token)
 *   GET  /matrices/latest         newest matrix; ?complete=1&trigger=cron  (read token)
 *   GET  /matrices/:id            { matrix, runs, sweep, complete }        (read token)
 *   GET  /matrices/:id/report     the markdown report for that matrix      (read token)
 *
 * Read = EVALS_READ_TOKEN or EVALS_API_TOKEN. Both unset → 503.
 */
import { z } from "zod";
import { configOf, type EvalEnv } from "./env.js";
import { DEFAULT_GATES, evaluateGates } from "./gates.js";
import { selectModels } from "./models.js";
import { renderReport } from "./report.js";
import { TaskIdSchema } from "./results.js";
import { matrixIdOf, newMatrixId, ResultStore, SAFE_ID } from "./store.js";
import { TASK_IDS } from "./tasks.js";
import { type MatrixParams, planRuns } from "./workflows/matrix-core.js";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

async function same(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function authorized(req: Request, tokens: (string | undefined)[]): Promise<boolean> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  for (const t of tokens) if (t && (await same(m[1]!, t))) return true;
  return false;
}

export const StartBody = z
  .object({
    tasks: z.array(TaskIdSchema).min(1).optional(),
    models: z.array(z.string()).min(1).optional(),
    runsPerCell: z.number().int().min(1).max(20).optional(),
    concurrency: z.number().int().min(1).max(20).optional(),
  })
  .strict();

/** Starts a matrix Workflow; returns its id and the planned run ids. */
export async function startMatrix(
  env: EvalEnv,
  opts: { trigger: "cron" | "manual" } & z.infer<typeof StartBody>,
  nowMs = Date.now(),
): Promise<{ matrixId: string; runIds: string[] }> {
  const cfg = configOf(env);
  const models = opts.models ? selectModels(opts.models.join(",")) : selectModels(env.EVAL_MODELS);
  const params: MatrixParams = {
    matrixId: newMatrixId(nowMs),
    trigger: opts.trigger,
    createdAt: new Date(nowMs).toISOString(),
    tasks: opts.tasks ?? [...TASK_IDS],
    models: models.map((m) => m.id),
    runsPerCell: opts.runsPerCell ?? cfg.runsPerCell,
    concurrency: opts.concurrency ?? cfg.concurrency,
  };
  await env.EVAL_MATRIX_WORKFLOW.create({ id: params.matrixId, params });
  return { matrixId: params.matrixId, runIds: planRuns(params).map((r) => r.runId) };
}

export async function handle(req: Request, env: EvalEnv): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return json({
      name: "gittifacts-evals",
      about: "Onboarding eval (docs/prompts/02-onboarding.md §7). See evals/onboarding/README.md.",
      endpoints: [
        "POST /runs",
        "GET /runs/:id",
        "GET /runs/:id/transcript",
        "GET /matrices",
        "GET /matrices/latest",
        "GET /matrices/:id",
        "GET /matrices/:id/report",
      ],
    });
  }
  if (!env.EVALS_API_TOKEN && !env.EVALS_READ_TOKEN) {
    return err(503, "not-configured", "set EVALS_API_TOKEN / EVALS_READ_TOKEN");
  }
  const store = new ResultStore(env.RESULTS);
  if (req.method === "POST" && parts[0] === "runs" && parts.length === 1) {
    if (!(await authorized(req, [env.EVALS_API_TOKEN])))
      return err(401, "unauthorized", "EVALS_API_TOKEN required");
    const body = StartBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success)
      return err(400, "invalid-body", body.error.issues.map((i) => i.message).join("; "));
    try {
      const out = await startMatrix(env, { trigger: "manual", ...body.data });
      return json({ ...out, statusUrl: `${url.origin}/matrices/${out.matrixId}` }, 202);
    } catch (e) {
      return err(400, "invalid-request", e instanceof Error ? e.message : String(e));
    }
  }
  if (req.method !== "GET") return err(405, "method-not-allowed", req.method);
  if (!(await authorized(req, [env.EVALS_READ_TOKEN, env.EVALS_API_TOKEN]))) {
    return err(401, "unauthorized", "EVALS_READ_TOKEN required");
  }
  const [kind, id, sub] = parts;
  if (kind === "runs" && id && SAFE_ID.test(id) && matrixIdOf(id)) {
    if (sub === "transcript") {
      const t = await store.getTranscript(id);
      return t === null ? err(404, "not-found", id) : json(t);
    }
    const r = await store.getRun(id);
    if (r) return json(r);
    try {
      const s = await (await env.EVAL_RUN_WORKFLOW.get(id)).status();
      return json({ runId: id, status: s.status, error: s.error?.message ?? null });
    } catch {
      return err(404, "not-found", id);
    }
  }
  if (kind === "matrices" && !id) return json({ matrices: await store.matrixIds() });
  if (kind === "matrices" && id) {
    const trigger = url.searchParams.get("trigger");
    const view =
      id === "latest"
        ? await store.latest({
            complete: url.searchParams.get("complete") === "1",
            ...(trigger === "cron" || trigger === "manual" ? { trigger } : {}),
          })
        : SAFE_ID.test(id)
          ? await store.view(id)
          : null;
    if (!view) return err(404, "not-found", id);
    if (sub === "report") {
      const gates = evaluateGates(view, { ...DEFAULT_GATES, maxAgeHours: null, nowMs: Date.now() });
      return new Response(renderReport(view, gates), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    return json(view);
  }
  return err(404, "not-found", url.pathname);
}
