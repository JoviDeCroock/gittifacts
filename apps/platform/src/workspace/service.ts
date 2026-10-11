/**
 * Remote workspaces, the service layer every surface (MCP tools; HTTP later) calls. It decides
 * who may do what, then hands the work to the `Workspace` Durable Object:
 *
 * - **open**: only the Change's author (agents and humans alike: the workspace pushes to the
 *   fork, which only the author's push grant may do), only for a Change that still accepts pushes,
 *   only for a change fork (`task-*`; a bootstrap Change checks out the main repo and has none),
 *   within the project's quota (vCPU-seconds per day) and open-workspace limit.
 * - **ws_***: the same author; the DO re-checks that the caller is who opened it.
 * - Repo scoping for delegated agents (`Principal.repoIds`) is enforced by the MCP backend before
 *   any of this runs (`assertTargetAllowed` on the workspace's Change).
 * - Audit: `workspace.opened`, `workspace.closed`, `workspace.pushed` as the caller;
 *   `workspace.expired` as the platform (from the DO).
 */
import {
  bootstrapChangeIdFor,
  changeWorkflowId,
  ciRunIdFor,
  isForkName,
  PUSHABLE_STATUSES,
  resolveRuntime,
  SYSTEM_PRINCIPAL_ID,
} from "@app/coordinator";
import type { Change, Principal, Repo } from "@app/domain";
import type {
  WorkspaceView,
  WsCommitPushResult,
  WsDiffResult,
  WsExecResult,
  WsReadResult,
  WsWriteResult,
} from "@app/mcp";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { ApiError, conflict, forbidden } from "../errors.js";
import { admitUnclaimedWork } from "../limits/gates.js";
import {
  assertSpendAllows,
  assertUnderDaily,
  type PlanGateEnv,
  WORKSPACE_CPU_SECONDS,
} from "../limits/plan-gate.js";
import { requireChange, requireRepo } from "../services/changes.js";
import type { LedgerUsage, ProjectLedger } from "./ledger-do.js";
import {
  changeIdOfWorkspace,
  INSTANCE_VCPU,
  limitsFor,
  type OpenSpec,
  type WorkspaceConfigVars,
  type WorkspaceErrorBody,
  type WorkspaceLimits,
  type WorkspaceResult,
  workspaceIdFor,
} from "./model.js";
import type { Workspace, WorkspaceViewData } from "./workspace-do.js";

/** The bindings the service needs (present in the Worker's `Env` once wired). */
export interface WorkspaceBindings {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  PROJECT_LEDGER: DurableObjectNamespace<ProjectLedger>;
  CI_BUCKET: R2Bucket;
}

function bindings(svc: Services): WorkspaceBindings & WorkspaceConfigVars {
  return svc.env as unknown as WorkspaceBindings & WorkspaceConfigVars;
}

const STATUS: Record<WorkspaceErrorBody["code"], ContentfulStatusCode> = {
  "not-found": 404,
  forbidden: 403,
  "invalid-state": 409,
  "invalid-input": 400,
  conflict: 409,
  "quota-exceeded": 429,
  upstream: 502,
};

/** A DO result → its value, or the platform's error envelope (code + message + fix). */
export function unwrap<T>(r: WorkspaceResult<T>): T {
  if (r.ok) return r.value;
  throw new ApiError(STATUS[r.error.code], r.error.code, r.error.message, undefined, r.error.fix);
}

function authorIdentity(p: Principal): { name: string; email: string } {
  return { name: p.name, email: `${p.id}@principals.gittifacts.dev` };
}

function nowMs(svc: Services): number {
  return svc.clock.now().getTime();
}

function toView(
  v: WorkspaceViewData,
  usage: LedgerUsage | null,
  limits: WorkspaceLimits,
): WorkspaceView {
  const remaining =
    usage?.cpuSecondsRemaining === null || usage === null
      ? null
      : Math.floor(usage.cpuSecondsRemaining / INSTANCE_VCPU[limits.instance]);
  return {
    workspaceId: v.workspaceId,
    changeId: v.changeId,
    repoId: v.repoId,
    forkName: v.forkName,
    branch: v.branch,
    baseSha: v.baseSha,
    headSha: v.headSha,
    status: v.status,
    network: v.network,
    expiresAt: v.expiresAt,
    idleSleepSec: v.idleSleepSec,
    restoredFrom: v.restoredFrom,
    usage: { containerSeconds: v.containerSeconds, projectSecondsRemaining: remaining },
  };
}

function quotaExceeded(repo: Repo, limits: WorkspaceLimits, usage: LedgerUsage): ApiError {
  const unclaimed = repo.claim.status !== "claimed";
  return new ApiError(
    429,
    "quota-exceeded",
    `project ${repo.id} used its workspace quota for ${usage.day} (${Math.round((limits.cpuSecondsPerDay ?? 0) / 60)} vCPU-minutes)`,
    {
      quota: "workspace-cpu-seconds-per-day",
      limit: limits.cpuSecondsPerDay,
      used: usage.cpuSecondsUsed,
    },
    {
      explanation: unclaimed
        ? "Unclaimed projects get a small daily sandbox quota. Give the project's claimUrl to a human to claim it (larger quota), or continue tomorrow (UTC)."
        : "The project's daily remote-workspace quota is used up; it resets at 00:00 UTC. You can still push from your own checkout.",
      call: "whoami({})",
    },
  );
}

/** Who may work in a Change's workspace: its author, on a change fork that still takes pushes. */
function assertCanWork(caller: Caller, change: Change): void {
  if (caller.principal.id !== change.authorId) {
    throw forbidden("only the change's author can open or use its workspace", undefined, {
      explanation:
        "A workspace pushes to the Change's fork, which only its author may do. Start your own Change and open its workspace.",
      call: `start_change({ repoId: "${change.repoId}", title: "<title>", category: "fix" })`,
    });
  }
  if (!isForkName(change.forkName)) {
    throw conflict(`change ${change.id} has no fork to work in`, "invalid-state", {
      explanation:
        "This Change checks out the main repo (a bootstrap run); workspaces only ever open a Change's fork. Start a Change to work on the project.",
      call: `start_change({ repoId: "${change.repoId}", title: "<title>", category: "feature" })`,
    });
  }
  if (!PUSHABLE_STATUSES.includes(change.status)) {
    throw conflict(`change is ${change.status}; it no longer accepts pushes`, "invalid-state", {
      explanation: "Start a new Change for further work.",
      call: `start_change({ repoId: "${change.repoId}", title: "<title>", category: "fix" })`,
    });
  }
}

/** The part of the CI engine's `RunSummary` (ci-runs/<runId>/summary.json) read here. */
const SummarySnapshots = z.object({ snapshots: z.record(z.string(), z.string()).default({}) });

/** The CI dependency snapshot for the Change: its own head's run, else the repo's bootstrap run. */
export async function findDependencySnapshot(
  bucket: R2Bucket,
  change: Pick<Change, "id" | "repoId" | "headSha" | "baseSha">,
): Promise<{ id: string; step: string } | null> {
  const runIds = [
    ...(change.headSha === null ? [] : [ciRunIdFor(changeWorkflowId(change.id, change.headSha))]),
    ciRunIdFor(changeWorkflowId(bootstrapChangeIdFor(change.repoId), change.baseSha)),
  ];
  for (const runId of runIds) {
    let raw: unknown;
    try {
      const obj = await bucket.get(`ci-runs/${runId}/summary.json`);
      if (obj === null) continue;
      raw = await obj.json();
    } catch {
      continue;
    }
    const summary = SummarySnapshots.safeParse(raw);
    if (!summary.success) continue;
    for (const step of ["install", "build"]) {
      const id = summary.data.snapshots[step];
      if (id !== undefined && id !== "") return { id, step };
    }
  }
  return null;
}

async function ledgerUsage(
  svc: Services,
  repo: Repo,
  limits: WorkspaceLimits,
): Promise<LedgerUsage> {
  return bindings(svc)
    .PROJECT_LEDGER.getByName(repo.id)
    .usage({ cpuSecondsPerDay: limits.cpuSecondsPerDay, atMs: nowMs(svc) });
}

interface Resolved {
  change: Change;
  repo: Repo;
  limits: WorkspaceLimits;
  workspaceId: string;
  stub: DurableObjectStub<Workspace>;
}

async function resolve(svc: Services, caller: Caller, workspaceId: string): Promise<Resolved> {
  const changeId = changeIdOfWorkspace(workspaceId);
  if (changeId === null) {
    throw new ApiError(404, "not-found", `workspace ${workspaceId} not found`, undefined, {
      explanation: "Workspace ids look like ws-<changeId>; open_workspace returns it.",
      call: 'open_workspace({ changeId: "<changeId>" })',
    });
  }
  const change = await requireChange(svc, changeId);
  assertCanWork(caller, change);
  const repo = await requireRepo(svc, change.repoId);
  const limits = limitsFor(repo, bindings(svc));
  return {
    change,
    repo,
    limits,
    workspaceId,
    stub: bindings(svc).WORKSPACE.getByName(workspaceId),
  };
}

// ---------------------------------------------------------------- operations

export async function openWorkspace(
  svc: Services,
  caller: Caller,
  changeId: string,
  opts: { waitMs?: number } = {},
): Promise<WorkspaceView> {
  const change = await requireChange(svc, changeId);
  assertCanWork(caller, change);
  const repo = await requireRepo(svc, change.repoId);
  const now = nowMs(svc);
  if (
    repo.claim.status !== "claimed" &&
    repo.claim.expiresAt !== null &&
    Date.parse(repo.claim.expiresAt) <= now
  ) {
    throw forbidden(`project ${repo.id} expired unclaimed`, undefined, {
      explanation: "Unclaimed projects expire after their TTL; create a new project.",
      call: "create_project({})",
    });
  }
  const limits = limitsFor(repo, bindings(svc));
  const workspaceId = workspaceIdFor(change.id);
  // O3: an unclaimed project's quotas (CI minutes, storage) and the checkout's Artifacts ops.
  if (caller.principal.id !== SYSTEM_PRINCIPAL_ID) {
    await admitUnclaimedWork(svc, repo, { ops: 1, what: "open_workspace" });
  }
  const ledger = bindings(svc).PROJECT_LEDGER.getByName(repo.id);
  const usage = await ledger.usage({ cpuSecondsPerDay: limits.cpuSecondsPerDay, atMs: now });
  // The platform's own workspaces (import proposals) are short and don't count against the
  // project's open-workspace limit or block on its quota; their time is still recorded.
  const platform = caller.principal.id === SYSTEM_PRINCIPAL_ID;
  if (!platform) {
    // The spend breaker, and the plan's vCPU-minutes per account (src/limits/plan-gate.ts).
    const env = svc.env as unknown as PlanGateEnv;
    await assertSpendAllows(env, repo.id, "workspace", now);
    if (limits.cpuSecondsPerDay !== null) {
      await assertUnderDaily(
        env,
        repo.id,
        {
          metric: WORKSPACE_CPU_SECONDS,
          quota: "workspace-cpu-minutes",
          perDay: limits.cpuSecondsPerDay / 60,
          unit: 60,
        },
        now,
      );
    }
  }
  if (!platform && usage.cpuSecondsRemaining !== null && usage.cpuSecondsRemaining <= 0) {
    throw quotaExceeded(repo, limits, usage);
  }
  const reserved = platform
    ? ({ ok: true } as const)
    : await ledger.reserve({ workspaceId, maxOpen: limits.maxOpen });
  if (!reserved.ok) {
    const other = reserved.open[0] ?? "<workspaceId>";
    throw new ApiError(
      429,
      repo.claim.status === "claimed" ? "quota-exceeded" : "unclaimed-limit",
      `project ${repo.id} already has ${reserved.open.length} open workspace(s) (limit ${limits.maxOpen})`,
      { open: reserved.open, limit: limits.maxOpen },
      {
        explanation: "Close a workspace you no longer need first.",
        call: `close_workspace({ workspaceId: "${other}" })`,
      },
    );
  }
  const git = resolveRuntime(svc.env, "default").ports.git;
  const head =
    change.headSha ??
    (await git.branchHead(change.forkName, repo.defaultBranch).catch(() => null)) ??
    change.baseSha;
  const depsSnapshot = await findDependencySnapshot(bindings(svc).CI_BUCKET, change);
  const spec: OpenSpec = {
    workspaceId,
    changeId: change.id,
    repoId: repo.id,
    forkName: change.forkName,
    remote: git.remoteOf(change.forkName),
    branch: repo.defaultBranch,
    baseSha: change.baseSha,
    headSha: head,
    ownerPrincipalId: caller.principal.id,
    author: authorIdentity(caller.principal),
    claimed: repo.claim.status === "claimed",
    network: limits.network,
    instance: limits.instance,
    ttlMs: limits.ttlMs,
    idleMs: limits.idleMs,
    maxExecTimeoutSec: limits.maxExecTimeoutSec,
    maxOutputBytes: limits.maxOutputBytes,
    depsSnapshot,
    ...(opts.waitMs === undefined ? {} : { waitMs: opts.waitMs }),
  };
  const r = await bindings(svc).WORKSPACE.getByName(workspaceId).open(spec);
  if (!r.ok) {
    if (r.error.code !== "forbidden") await ledger.release(workspaceId).catch(() => {});
    unwrap(r);
  }
  const view = unwrap(r);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "workspace.opened",
    subject: `change:${change.id}`,
    payload: {
      workspaceId,
      headSha: head,
      status: view.status,
      network: view.network,
      instance: limits.instance,
      expiresAt: view.expiresAt,
      restoredFrom: view.restoredFrom,
      dependencySnapshot: depsSnapshot?.step ?? null,
    },
  });
  return toView(view, usage, limits);
}

export async function closeWorkspace(
  svc: Services,
  caller: Caller,
  workspaceId: string,
): Promise<WorkspaceView> {
  const changeId = changeIdOfWorkspace(workspaceId);
  if (changeId === null) unwrap({ ok: false, error: notAWorkspace(workspaceId) });
  const change = await requireChange(svc, changeId ?? "");
  // Closing is allowed whatever the Change's status (a merged Change's workspace still runs).
  if (caller.principal.id !== change.authorId) assertCanWork(caller, change);
  const repo = await requireRepo(svc, change.repoId);
  const limits = limitsFor(repo, bindings(svc));
  const view = unwrap(
    await bindings(svc).WORKSPACE.getByName(workspaceId).close(caller.principal.id, "closed"),
  );
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "workspace.closed",
    subject: `change:${change.id}`,
    payload: { workspaceId, headSha: view.headSha, containerSeconds: view.containerSeconds },
  });
  return toView(view, await ledgerUsage(svc, repo, limits).catch(() => null), limits);
}

function notAWorkspace(workspaceId: string): WorkspaceErrorBody {
  return {
    code: "not-found",
    message: `workspace ${workspaceId} not found`,
    fix: {
      explanation: "Workspace ids look like ws-<changeId>; open_workspace returns it.",
      call: 'open_workspace({ changeId: "<changeId>" })',
    },
  };
}

export async function wsExec(
  svc: Services,
  caller: Caller,
  input: { workspaceId: string; command: string; cwd?: string; timeoutSec?: number },
): Promise<WsExecResult> {
  const w = await resolve(svc, caller, input.workspaceId);
  const usage = await ledgerUsage(svc, w.repo, w.limits);
  if (usage.cpuSecondsRemaining !== null && usage.cpuSecondsRemaining <= 0) {
    // An expired or closed workspace says so first (its fix is to reopen); a live one is over quota.
    const d = await w.stub.describe(caller.principal.id);
    if (!d.ok || ["starting", "ready", "sleeping"].includes(d.value.status)) {
      throw quotaExceeded(w.repo, w.limits, usage);
    }
  }
  const budgetSec =
    usage.cpuSecondsRemaining === null
      ? null
      : Math.max(1, Math.floor(usage.cpuSecondsRemaining / INSTANCE_VCPU[w.limits.instance]));
  const r = unwrap(
    await w.stub.exec(caller.principal.id, {
      command: input.command,
      cwd: input.cwd ?? ".",
      timeoutSec: input.timeoutSec ?? 120,
      budgetSec,
    }),
  );
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    stdout: r.stdout.text,
    stderr: r.stderr.text,
    stdoutBytes: r.stdout.bytes,
    stderrBytes: r.stderr.bytes,
    stdoutTruncated: r.stdout.truncated,
    stderrTruncated: r.stderr.truncated,
  };
}

export async function wsRead(
  svc: Services,
  caller: Caller,
  input: { workspaceId: string; path: string; startLine?: number; endLine?: number },
): Promise<WsReadResult> {
  const w = await resolve(svc, caller, input.workspaceId);
  return unwrap(
    await w.stub.read(caller.principal.id, {
      path: input.path,
      ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
      ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
    }),
  );
}

export async function wsWrite(
  svc: Services,
  caller: Caller,
  input: { workspaceId: string; path: string; content?: string; patch?: string },
): Promise<WsWriteResult> {
  const w = await resolve(svc, caller, input.workspaceId);
  return unwrap(
    await w.stub.write(caller.principal.id, {
      path: input.path,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.patch === undefined ? {} : { patch: input.patch }),
    }),
  );
}

export async function wsDiff(
  svc: Services,
  caller: Caller,
  workspaceId: string,
): Promise<WsDiffResult> {
  const w = await resolve(svc, caller, workspaceId);
  const d = unwrap(await w.stub.diff(caller.principal.id));
  return { baseSha: d.baseSha, files: d.files, patch: d.patch, truncated: d.truncated };
}

export async function wsCommitPush(
  svc: Services,
  caller: Caller,
  input: { workspaceId: string; message: string },
): Promise<WsCommitPushResult> {
  const w = await resolve(svc, caller, input.workspaceId);
  // O3: each push mints a write token for the fork (one Artifacts operation).
  if (caller.principal.id !== SYSTEM_PRINCIPAL_ID) {
    await admitUnclaimedWork(svc, w.repo, { ops: 1, what: "ws_commit_push" });
  }
  const r = unwrap(await w.stub.commitPush(caller.principal.id, { message: input.message }));
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "workspace.pushed",
    subject: `change:${w.change.id}`,
    payload: {
      workspaceId: w.workspaceId,
      forkName: w.change.forkName,
      branch: r.branch,
      headSha: r.commitSha,
      previousHead: r.previousHead,
      files: r.filesChanged,
    },
  });
  return { changeId: w.change.id, ...r };
}
