/**
 * The CI port's gate: every CI run goes through here, whoever starts it (ChangeWorkflow,
 * bootstrap, merge-queue re-check), because it wraps the coordinator's `ci` port at the runtime
 * seam (src/index.ts).
 *
 * Every project: while the spend breaker is tripped (src/spend/breaker.ts) no run starts, except
 * the merge queue's (approved Changes still land). Claimed projects: the plan's CI quota
 * (src/limits/plans.ts), container-minutes per day per project and per account, a per-run cap and
 * an instance ceiling. Unclaimed projects (onboarding §4), below:
 *
 * Before a run starts it must pass the project's expiry, storage, Artifacts-operation and CI-minute
 * quotas (project and per-IP). A run that passes is clamped: `limits.maxMinutes` = the minutes
 * granted (≤ the per-run cap), smaller log and artifact caps, a smaller instance ceiling,
 * `network: "registries-only"` (also what the coordinator asks for: belt and braces) and the
 * global CI cache read-only (an unclaimed project can't publish snapshots other repos reuse).
 *
 * A run that fails a quota never starts a container: it is reported as a failed run with one
 * step, `unclaimed-limits`, whose log says which quota and how to lift it (claim the project),
 * so the Change turns `failing` with a reason instead of hanging.
 */
import {
  type CiEngine,
  type CiRunRequest,
  type Ports,
  type PortsRole,
  SYSTEM_PRINCIPAL_ID,
} from "@app/coordinator";
import type { Repo } from "@app/domain";
import { ApiError } from "../errors.js";
import { spendPaused } from "../spend/breaker.js";
import { D1Store } from "../store/d1-store.js";
import type { ProjectLedger } from "../workspace/ledger-do.js";
import { type LimitsEnv, type UnclaimedLimits, unclaimedLimits } from "./config.js";
import { type PlanGateEnv, planQuotaError } from "./plan-gate.js";
import { type PlanLimits, planLedgers, planLimits, planOf } from "./plans.js";
import { chargeArtifactsOps, GLOBAL_LEDGER, ledgersFor, quotaExceeded, usageOf } from "./quotas.js";

export const LIMIT_STEP = "unclaimed-limits";
/** The refused run's step for claimed projects (plan quota) and for the spend breaker. */
export const PLAN_STEP = "plan-limits";

export interface CiQuotaEnv extends LimitsEnv, PlanGateEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  CI_BUCKET: R2Bucket;
  COORDINATOR: { getByName(name: string): { onRunFinished(summary: unknown): Promise<unknown> } };
}

async function refusal(
  env: CiQuotaEnv,
  store: D1Store,
  repo: Repo,
  req: CiRunRequest,
  l: UnclaimedLimits,
  atMs: number,
): Promise<{ refused: string } | { minutes: number }> {
  if (repo.claim.expiresAt !== null && Date.parse(repo.claim.expiresAt) <= atMs) {
    return { refused: `project ${repo.id} expired unclaimed; create a new project.` };
  }
  const u = await usageOf(env, store, repo.id, atMs);
  const over = (e: ApiError) => ({ refused: `${e.message}. ${e.fix.explanation}` });
  if (u.project.storageBytes >= l.storageBytes)
    return over(
      quotaExceeded(
        repo,
        "storage-bytes",
        "project",
        u.project.storageBytes,
        l.storageBytes,
        null,
        null,
      ),
    );
  if (u.ip !== null && u.ip.storageBytes >= l.perIp.storageBytes)
    return over(
      quotaExceeded(
        repo,
        "storage-bytes",
        "ip",
        u.ip.storageBytes,
        l.perIp.storageBytes,
        null,
        null,
      ),
    );
  try {
    // The run mints read tokens and checks the repo out: one Artifacts operation.
    await chargeArtifactsOps(env, store, repo, 1, l, atMs, null);
  } catch (e) {
    if (e instanceof ApiError) return over(e);
    throw e;
  }
  const { project, ip } = await ledgersFor(env, store, repo.id);
  const p = await project.reserveCi({
    runId: req.runId,
    maxMinutes: l.ci.minutesPerRun,
    perDay: l.ci.minutesPerDay,
    minMinutes: 1,
    atMs,
  });
  if (!p.ok)
    return over(
      quotaExceeded(repo, "ci-minutes", "project", p.usedMinutes, l.ci.minutesPerDay, null, null),
    );
  let minutes = p.minutes;
  const release = async (ledgers: Array<DurableObjectStub<ProjectLedger>>) => {
    for (const x of ledgers) await x.settleCi({ runId: req.runId, actualMinutes: 0 });
  };
  if (ip !== null) {
    const i = await ip.reserveCi({
      runId: req.runId,
      maxMinutes: minutes,
      perDay: l.perIp.ciMinutesPerDay,
      minMinutes: 1,
      atMs,
    });
    if (!i.ok) {
      await release([project]);
      return over(
        quotaExceeded(repo, "ci-minutes", "ip", i.usedMinutes, l.perIp.ciMinutesPerDay, null, null),
      );
    }
    minutes = Math.min(minutes, i.minutes);
  }
  // Platform-wide: every unclaimed project's CI together (a cost bound).
  const g = await env.PROJECT_LEDGER.getByName(GLOBAL_LEDGER).reserveCi({
    runId: req.runId,
    maxMinutes: minutes,
    perDay: l.globalCiMinutesPerDay,
    minMinutes: 1,
    atMs,
  });
  if (!g.ok) {
    await release(ip === null ? [project] : [project, ip]);
    return over(
      quotaExceeded(
        repo,
        "ci-minutes",
        "global",
        g.usedMinutes,
        l.globalCiMinutesPerDay,
        null,
        null,
      ),
    );
  }
  return { minutes: Math.min(minutes, g.minutes) };
}

/** The request an unclaimed project's run actually gets. */
export function clampRequest(req: CiRunRequest, minutes: number, l: UnclaimedLimits): CiRunRequest {
  const { budget: _budget, ...rest } = req;
  const asked = req.limits?.maxMinutes ?? req.budget?.maxMinutes ?? minutes;
  const limits = {
    ...(req.limits ?? {}),
    maxMinutes: Math.max(1, Math.min(asked, minutes)),
    maxLogBytes: Math.min(req.limits?.maxLogBytes ?? l.ci.maxLogBytes, l.ci.maxLogBytes),
    maxArtifactBytes: l.ci.maxArtifactBytes,
    instance: l.ci.instance,
  };
  const cache = (req as { cache?: Record<string, unknown> }).cache ?? {};
  return {
    ...rest,
    limits,
    network: "registries-only",
    cache: { ...cache, global: "read-only" },
  } as CiRunRequest;
}

async function reportRefused(
  env: CiQuotaEnv,
  req: CiRunRequest,
  message: string,
  step = LIMIT_STEP,
): Promise<void> {
  const at = new Date().toISOString();
  const logRef = `ci-logs/${req.runId}/${step}.log`;
  await env.CI_BUCKET.put(logRef, `${message}\n`, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await env.COORDINATOR.getByName(req.changeId).onRunFinished({
    id: req.runId,
    changeId: req.changeId,
    headSha: req.headSha,
    baseSha: req.baseSha,
    engine: "workflows",
    status: "failed",
    startedAt: at,
    finishedAt: at,
    steps: [
      {
        name: step,
        kind: "user",
        status: "failed",
        durationMs: 0,
        logRef,
        cacheHit: false,
        reason: message,
      },
    ],
    evidence: [],
    evidenceErrors: [],
    error: message,
  });
}

/**
 * Admit a claimed project's run against its plan: refused once today's container-minutes of the
 * project or its account reach the plan's day; otherwise its budget is the per-run cap, at most
 * what is left of either day. Nothing is held while it runs (concurrent runs don't refuse each
 * other); the run's container-minutes are added when it finishes (./coordinator-do.ts).
 */
async function planVerdict(
  env: CiQuotaEnv,
  repo: Repo,
  req: CiRunRequest,
  l: PlanLimits,
  atMs: number,
): Promise<{ refused: string } | { minutes: number }> {
  const { project, account } = await planLedgers(env, repo.id);
  const over = (scope: "project" | "account", used: number, limit: number) => {
    const e = planQuotaError(repo.id, "ci-minutes", scope, used, limit, atMs);
    return { refused: `${e.message}. ${e.fix.explanation}` };
  };
  const p = await project.admitCi({ runId: req.runId, perDay: l.ci.minutesPerDay, atMs });
  if (!p.ok) return over("project", p.usedMinutes, l.ci.minutesPerDay);
  let minutes = Math.min(l.ci.minutesPerRun, Math.ceil(p.minutesLeft));
  if (account !== null) {
    const perDay = l.ci.minutesPerDay * l.accountMultiplier;
    const a = await account.admitCi({ runId: req.runId, perDay, atMs });
    if (!a.ok) {
      await project.settleCi({ runId: req.runId, actualMinutes: 0 });
      return over("account", a.usedMinutes, perDay);
    }
    minutes = Math.min(minutes, Math.ceil(a.minutesLeft));
  }
  return { minutes };
}

/** A claimed project's run: the plan's minutes and instance ceiling; egress and cache as asked. */
export function clampPlanRequest(req: CiRunRequest, minutes: number, l: PlanLimits): CiRunRequest {
  const { budget: _budget, ...rest } = req;
  const asked = req.limits?.maxMinutes ?? req.budget?.maxMinutes ?? minutes;
  return {
    ...rest,
    limits: {
      ...(req.limits ?? {}),
      maxMinutes: Math.max(1, Math.min(asked, minutes)),
      instance: l.ci.instance,
    },
  } as CiRunRequest;
}

export function unclaimedCi(
  inner: CiEngine,
  env: CiQuotaEnv,
  audit?: Ports["audit"],
  role: PortsRole = "default",
): CiEngine {
  const store = () => new D1Store(env.DB, env.BLOBS);
  const refuse = async (repo: Repo, req: CiRunRequest, detail: string, step: string) => {
    await audit
      ?.append({
        principalId: SYSTEM_PRINCIPAL_ID,
        action: "limit.hit",
        subject: `repo:${repo.id}`,
        payload: { limit: "ci", runId: req.runId, changeId: req.changeId, detail },
      })
      .catch(() => undefined);
    await reportRefused(env, req, detail, step);
    return { runId: req.runId };
  };
  return {
    async start(req) {
      const s = store();
      const change = await s.getChange(req.changeId);
      const repo = change === null ? null : await s.getRepo(change.repoId);
      if (repo === null) return inner.start(req);
      const atMs = Date.now();
      // The merge queue lands approved Changes even while the breaker is tripped.
      if (role !== "merge-queue") {
        const paused = await spendPaused(env, atMs);
        if (paused !== null) return refuse(repo, req, paused, PLAN_STEP);
      }
      if (repo.claim.status === "claimed") {
        const pl = planLimits(env, planOf(repo));
        const v = await planVerdict(env, repo, req, pl, atMs);
        if ("refused" in v) return refuse(repo, req, v.refused, PLAN_STEP);
        return inner.start(clampPlanRequest(req, v.minutes, pl));
      }
      const l = unclaimedLimits(env);
      const verdict = await refusal(env, s, repo, req, l, atMs);
      if ("refused" in verdict) return refuse(repo, req, verdict.refused, LIMIT_STEP);
      return inner.start(clampRequest(req, verdict.minutes, l));
    },
    async status(runId) {
      const run = await store().getRun(runId);
      if (
        run?.status === "failed" &&
        run.steps.some((st) => st.name === LIMIT_STEP || st.name === PLAN_STEP)
      ) {
        return {
          id: run.id,
          changeId: run.changeId,
          headSha: run.headSha,
          baseSha: run.headSha,
          engine: "workflows",
          status: "failed",
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          steps: [],
        };
      }
      return inner.status(runId);
    },
    cancel: (runId, reason) => inner.cancel(runId, reason),
    restartFrom: (runId, step) => inner.restartFrom(runId, step),
  };
}

/** Wrap a Ports' CI engine (every role) with the gate: spend breaker, plan, unclaimed quotas. */
export function withUnclaimedLimits<P extends Pick<Ports, "ci" | "audit">>(
  ports: P,
  env: CiQuotaEnv,
  role: PortsRole = "default",
): P {
  return { ...ports, ci: unclaimedCi(ports.ci, env, ports.audit, role) };
}
