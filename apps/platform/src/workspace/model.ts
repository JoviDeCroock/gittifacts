/**
 * Remote workspaces (onboarding §6): ids, per-claim limits, path rules and the persisted record.
 * Pure: no bindings, no I/O. The Workspace Durable Object (./workspace-do.ts) drives the
 * container; the service (./service.ts) authorizes callers; both share these rules.
 */
import type { InstanceType } from "@app/ci-engine";
import type { Repo } from "@app/domain";
import { z } from "zod";
import { planLimits, planOf } from "../limits/plans.js";

// ---------------------------------------------------------------- ids

export const WORKSPACE_PREFIX = "ws-";

/** One workspace per Change: re-opening resumes it (or starts a fresh generation once closed). */
export function workspaceIdFor(changeId: string): string {
  return `${WORKSPACE_PREFIX}${changeId}`;
}

/** The Change a workspace id belongs to, or null for anything that isn't one. */
export function changeIdOfWorkspace(workspaceId: string): string | null {
  return /^ws-([A-Za-z0-9_-]{1,64})$/.exec(workspaceId)?.[1] ?? null;
}

// ---------------------------------------------------------------- limits

export type WorkspaceNetwork = "open" | "registries-only";

export interface WorkspaceLimits {
  /** Hard end of a workspace session, from when it was opened. */
  ttlMs: number;
  /** Idle time before the workspace sleeps (snapshot + stop). */
  idleMs: number;
  instance: InstanceType;
  network: WorkspaceNetwork;
  /** vCPU-seconds of container time per project per UTC day (null: unlimited). */
  cpuSecondsPerDay: number | null;
  /** Workspaces open at once per project. */
  maxOpen: number;
  maxExecTimeoutSec: number;
  /** stdout and stderr of one ws_exec, each. */
  maxOutputBytes: number;
}

/** vCPUs per instance type (Containers limits), for vCPU-second accounting. */
export const INSTANCE_VCPU: Record<InstanceType, number> = {
  lite: 1 / 16,
  "standard-1": 0.5,
  "standard-2": 1,
  "standard-3": 2,
  "standard-4": 4,
};

/** Optional overrides (wrangler vars), in minutes. */
export interface WorkspaceConfigVars {
  WORKSPACE_TTL_CLAIMED_MIN?: string;
  WORKSPACE_TTL_UNCLAIMED_MIN?: string;
  WORKSPACE_IDLE_MIN?: string;
  WORKSPACE_CPU_MIN_PER_DAY_CLAIMED?: string;
  WORKSPACE_CPU_MIN_PER_DAY_UNCLAIMED?: string;
  /** The free plan's overrides (src/limits/plans.ts): claimed projects' TTL, quota, open count. */
  FREE_LIMITS?: string;
}

export const DEFAULT_LIMITS = {
  // The free plan (src/limits/plans.ts FREE_PLAN.workspace); FREE_LIMITS overrides it.
  claimed: {
    ttlMs: 60 * 60_000,
    idleMs: 10 * 60_000,
    instance: "standard-2",
    cpuSecondsPerDay: 60 * 60,
    maxOpen: 1,
    maxExecTimeoutSec: 1800,
    maxOutputBytes: 64 * 1024,
  },
  unclaimed: {
    ttlMs: 30 * 60_000,
    idleMs: 5 * 60_000,
    instance: "standard-1",
    cpuSecondsPerDay: 30 * 60,
    maxOpen: 1,
    maxExecTimeoutSec: 600,
    maxOutputBytes: 32 * 1024,
  },
} as const satisfies Record<"claimed" | "unclaimed", Omit<WorkspaceLimits, "network">>;

function minutes(value: string | undefined, fallbackMs: number): number {
  const n = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60_000) : fallbackMs;
}

/**
 * Limits follow the claim status. Unclaimed projects always get registries-only egress and the
 * tight quota (onboarding §4); a claimed project's policy may also ask for registries-only.
 */
export function limitsFor(
  repo: Pick<Repo, "claim" | "policy">,
  vars: WorkspaceConfigVars = {},
): WorkspaceLimits {
  if (repo.claim.status !== "claimed") {
    const d = DEFAULT_LIMITS.unclaimed;
    return {
      ...d,
      ttlMs: minutes(vars.WORKSPACE_TTL_UNCLAIMED_MIN, d.ttlMs),
      idleMs: Math.min(minutes(vars.WORKSPACE_IDLE_MIN, d.idleMs), d.idleMs),
      cpuSecondsPerDay:
        minutes(vars.WORKSPACE_CPU_MIN_PER_DAY_UNCLAIMED, d.cpuSecondsPerDay * 1000) / 1000,
      network: "registries-only",
    };
  }
  const d = DEFAULT_LIMITS.claimed;
  const plan = planLimits(vars, planOf(repo)).workspace;
  return {
    ...d,
    maxOpen: plan.maxOpen,
    ttlMs: minutes(vars.WORKSPACE_TTL_CLAIMED_MIN, plan.ttlMinutes * 60_000),
    idleMs: minutes(vars.WORKSPACE_IDLE_MIN, d.idleMs),
    cpuSecondsPerDay:
      minutes(vars.WORKSPACE_CPU_MIN_PER_DAY_CLAIMED, plan.cpuMinutesPerDay * 60_000) / 1000,
    network: repo.policy.sandbox?.network === "registries-only" ? "registries-only" : "open",
  };
}

// ---------------------------------------------------------------- paths

export const WORKSPACE_ROOT = "/workspace";

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A repository-relative path, normalized (`a/./b` → `a/b`), that stays inside the checkout.
 * Absolute paths, `..` that climbs out, NUL/newlines and anything under `.git/` are rejected.
 * The container re-checks with `realpath` (symlinks), so this is the first of two fences.
 */
export function checkWorkspacePath(raw: string, opts: { allowRoot?: boolean } = {}): PathCheck {
  if (raw.length === 0 || raw.length > 1024) return { ok: false, reason: "empty or too long" };
  if (/[\0\n\r]/.test(raw)) return { ok: false, reason: "contains NUL or a newline" };
  let p = raw.replaceAll("\\", "/");
  if (p.startsWith(`${WORKSPACE_ROOT}/`)) p = p.slice(WORKSPACE_ROOT.length + 1);
  else if (p === WORKSPACE_ROOT) p = ".";
  if (p.startsWith("/")) return { ok: false, reason: "absolute paths outside /workspace" };
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return { ok: false, reason: "climbs out of the workspace" };
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) {
    return opts.allowRoot === true ? { ok: true, path: "." } : { ok: false, reason: "is the root" };
  }
  if (parts[0] === ".git") return { ok: false, reason: "is inside .git (git's own files)" };
  return { ok: true, path: parts.join("/") };
}

// ---------------------------------------------------------------- record

export const WorkspaceStatus = z.enum(["starting", "ready", "sleeping", "closed", "expired"]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const RestoredFrom = z.enum(["sleep-snapshot", "dependency-snapshot", "image"]);
export type RestoredFrom = z.infer<typeof RestoredFrom>;

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/** What the service hands the Durable Object when a workspace is opened. */
export const OpenSpec = z
  .object({
    workspaceId: z.string().min(4).max(100),
    changeId: z.string().min(1).max(64),
    repoId: z.string().min(1).max(64),
    forkName: z
      .string()
      .regex(/^task-[A-Za-z0-9_-]+$/, "workspaces only ever check out a change fork"),
    remote: z.string().url(),
    branch: z.string().min(1).max(200),
    baseSha: Sha,
    /** The commit to check out (the Change's head, or the fork's tip, or base). */
    headSha: Sha,
    ownerPrincipalId: z.string().min(1).max(64),
    author: z.object({ name: z.string().min(1).max(120), email: z.string().min(3).max(200) }),
    claimed: z.boolean(),
    network: z.enum(["open", "registries-only"]),
    instance: z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]),
    ttlMs: z.number().int().positive(),
    idleMs: z.number().int().positive(),
    maxExecTimeoutSec: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    /** A dependency snapshot (the CI install step's), when one exists. */
    depsSnapshot: z
      .object({ id: z.string().min(1).max(512), step: z.string().max(100) })
      .nullable(),
    /** How long `open` may wait for the container before returning `starting`. */
    waitMs: z.number().int().min(0).max(120_000).default(25_000),
  })
  .strict();
export type OpenSpec = z.input<typeof OpenSpec>;

export const WorkspaceRecord = z.object({
  v: z.literal(1),
  spec: OpenSpec,
  status: WorkspaceStatus,
  generation: z.number().int().nonnegative(),
  openedAt: z.string(),
  expiresAt: z.string(),
  lastActiveAt: z.number(),
  /** The workspace branch's commit (after checkout, or the last commit pushed from here). */
  headSha: Sha.nullable(),
  sleepSnapshotId: z.string().nullable(),
  restoredFrom: RestoredFrom.nullable(),
  /** Epoch ms the running container started (null when stopped). */
  containerStartedAt: z.number().nullable(),
  /** Container milliseconds accumulated while stopped segments ended. */
  containerMs: z.number().nonnegative(),
  /** Of those, how many were already reported to the project ledger. */
  reportedMs: z.number().nonnegative(),
  lastError: z.string().nullable(),
  egressDenied: z.number().int().nonnegative(),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;

/** Errors the Durable Object returns (never throws across RPC): code + message + fix. */
export interface WorkspaceErrorBody {
  code:
    | "not-found"
    | "forbidden"
    | "invalid-state"
    | "invalid-input"
    | "conflict"
    | "quota-exceeded"
    | "upstream";
  message: string;
  fix: { explanation: string; call?: string; command?: string };
}

export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: WorkspaceErrorBody };
