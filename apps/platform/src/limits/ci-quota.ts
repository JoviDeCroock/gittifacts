/**
 * The CI port for unclaimed projects (onboarding §4): every CI run of an unclaimed project goes
 * through here, whoever starts it (ChangeWorkflow, bootstrap, merge-queue re-check), because it
 * wraps the coordinator's `ci` port at the runtime seam (src/index.ts).
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
  SYSTEM_PRINCIPAL_ID,
} from "@app/coordinator";
import type { Repo } from "@app/domain";
import { ApiError } from "../errors.js";
import { D1Store } from "../store/d1-store.js";
import type { ProjectLedger } from "../workspace/ledger-do.js";
import { type LimitsEnv, type UnclaimedLimits, unclaimedLimits } from "./config.js";
import {
  chargeArtifactsOps,
  GLOBAL_LEDGER,
  ledgersFor,
  type QuotaEnv,
  quotaExceeded,
  usageOf,
} from "./quotas.js";

export const LIMIT_STEP = "unclaimed-limits";

export interface CiQuotaEnv extends QuotaEnv, LimitsEnv {
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

async function reportRefused(env: CiQuotaEnv, req: CiRunRequest, message: string): Promise<void> {
  const at = new Date().toISOString();
  const logRef = `ci-logs/${req.runId}/${LIMIT_STEP}.log`;
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
        name: LIMIT_STEP,
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

export function unclaimedCi(inner: CiEngine, env: CiQuotaEnv, audit?: Ports["audit"]): CiEngine {
  const store = () => new D1Store(env.DB, env.BLOBS);
  return {
    async start(req) {
      const s = store();
      const change = await s.getChange(req.changeId);
      const repo = change === null ? null : await s.getRepo(change.repoId);
      if (repo === null || repo.claim.status === "claimed") return inner.start(req);
      const l = unclaimedLimits(env);
      const verdict = await refusal(env, s, repo, req, l, Date.now());
      if ("refused" in verdict) {
        await audit
          ?.append({
            principalId: SYSTEM_PRINCIPAL_ID,
            action: "limit.hit",
            subject: `repo:${repo.id}`,
            payload: {
              limit: "ci",
              runId: req.runId,
              changeId: req.changeId,
              detail: verdict.refused,
            },
          })
          .catch(() => undefined);
        await reportRefused(env, req, verdict.refused);
        return { runId: req.runId };
      }
      return inner.start(clampRequest(req, verdict.minutes, l));
    },
    async status(runId) {
      const run = await store().getRun(runId);
      if (run?.status === "failed" && run.steps.some((st) => st.name === LIMIT_STEP)) {
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

/** Wrap a Ports' CI engine (every role) with the unclaimed-project gate. */
export function withUnclaimedLimits<P extends Pick<Ports, "ci" | "audit">>(
  ports: P,
  env: CiQuotaEnv,
): P {
  return { ...ports, ci: unclaimedCi(ports.ci, env, ports.audit) };
}
