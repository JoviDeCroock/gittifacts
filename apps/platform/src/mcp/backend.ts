/**
 * The platform's `McpBackend`: every tool goes through the same service functions as the HTTP
 * routes (src/services/*), so rules live in one place. Mutating tools are idempotent per
 * (principal, idempotencyKey) through the same store as the `Idempotency-Key` header.
 *
 * Repo access (../access/): `scoped` checks every tool's repo, plan or change before it runs
 * (404 for repos the agent's owner cannot see, `repo-not-granted` outside a delegated session's
 * grant), and every mutation (they all run through `idem`) needs `contribute` on the repo its
 * `scoped` call named, so a reader's agent can read and nothing else. The services re-check.
 */
import { Principal } from "@app/domain";
import type { McpBackend, McpCaller } from "@app/mcp";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { type AccessTarget, assertTargetAccess } from "../access/access.js";
import { listMembers } from "../access/members.js";
import type { RepoNeed } from "../access/roles.js";
import { anonymousWhoami } from "../claim/anonymous.js";
import { createUnclaimedProject } from "../claim/create.js";
import { toErrorResponse, unauthorized } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { createImportMcpBackend } from "../import/mcp.js";
import type { AnonymousClient } from "../limits/client.js";
import { createQueueMcpBackend } from "../queue/mcp.js";
import { capabilities } from "../services/capabilities.js";
import {
  getChangeDetail,
  getChangeEvidence,
  getChangeTour,
  listChangeIssues,
  refreshPushGrant,
  requestReview,
  requireChange,
  startChange,
} from "../services/changes.js";
import { createPlan } from "../services/plans.js";
import { createProject } from "../services/projects.js";
import { listRepoSummaries } from "../services/repos.js";
import { createWorkspaceMcpBackend } from "../workspace/mcp.js";

/** `authInfo.clientId` of a caller without credentials (src/mcp/route.ts). */
export const ANONYMOUS_CLIENT_ID = "anonymous";

const AnonymousExtra = z.object({
  ipHash: z.string().min(1),
  asn: z.number().int().nullable(),
  country: z.string().nullable(),
});

/** A caller without credentials (only create_project and whoami reach here). */
function anonymousFrom(c: McpCaller): AnonymousClient | null {
  if (c.principalId !== ANONYMOUS_CLIENT_ID) return null;
  const parsed = AnonymousExtra.safeParse(c.authInfo.extra?.anonymous);
  return parsed.success ? parsed.data : null;
}

/** The bearer verifier puts the verified Principal in `authInfo.extra.principal`. */
function callerFrom(c: McpCaller): Caller {
  const parsed = Principal.safeParse(c.authInfo.extra?.principal);
  if (!parsed.success || parsed.data.id !== c.principalId)
    throw unauthorized("unverified MCP caller");
  return {
    principal: parsed.data,
    user: null,
    via: "agent-token",
    expiresAtSec: c.authInfo.expiresAt,
  };
}

export function createPlatformMcpBackend(svc: Services): McpBackend {
  /** What each `scoped` caller named, so `idem` can demand `contribute` on it. */
  const targets = new WeakMap<Caller, AccessTarget>();

  /** Mutations: at most once per (principal, key), and only with `contribute` on the repo. */
  const idem = async <T>(
    c: Caller,
    tool: string,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const target = targets.get(c);
    if (target !== undefined) await assertTargetAccess(svc, c.principal, target, "contribute");
    return runIdempotent(svc, c.principal.id, key, { method: "MCP", path: tool, body }, fn);
  };

  /** The verified caller, after checking it may `need` (default read) the repo the tool names. */
  const scoped = async (
    mc: Parameters<typeof callerFrom>[0],
    target: AccessTarget,
    need: RepoNeed = "read",
  ) => {
    const caller = callerFrom(mc);
    await assertTargetAccess(svc, caller.principal, target, need);
    targets.set(caller, target);
    return caller;
  };

  return {
    // Remote workspaces (open_workspace, ws_*) and import detection (propose_platform_config).
    ...createWorkspaceMcpBackend(svc, { scoped, idem }),
    ...createImportMcpBackend(svc, { scoped, idem }),
    // Merge queue (enqueue, queue_status, wait_for_merge, dequeue, reprioritize, queue_overview).
    ...createQueueMcpBackend(svc, { scoped, idem }),
    async whoami(mc) {
      if (anonymousFrom(mc) !== null) return anonymousWhoami(svc);
      const caps = await capabilities(svc, callerFrom(mc));
      return {
        principal: caps.principal,
        canApprove: caps.canApprove,
        repos: caps.repos.map((r) => ({
          id: r.id,
          name: r.name,
          claim: r.claim,
          actions: r.actions,
        })),
        quotas: {
          enforced: caps.quotas.enforced,
          ciMinutesPerDay: caps.quotas.ciMinutesPerDay,
          ciMinutesUsedToday: caps.quotas.ciMinutesUsedToday,
          artifactsOpsPerDay: caps.quotas.artifactsOpsPerDay,
        },
      };
    },

    async createProject(mc, input, opts) {
      // No credentials: an unclaimed project with its own token and claim link (O3).
      const anonymous = anonymousFrom(mc);
      if (anonymous !== null) {
        return createUnclaimedProject(svc, anonymous, input, opts.idempotencyKey);
      }
      // Not stored by the idempotency table (the result holds a push grant): the coordinator
      // derives the repo and first-change ids from (caller, key), so a retry finds them.
      return createProject(svc, callerFrom(mc), input, opts.idempotencyKey);
    },

    async listRepos(mc) {
      return listRepoSummaries(svc, callerFrom(mc));
    },

    async createPlan(mc, input, opts) {
      const caller = await scoped(mc, { repoId: input.repoId }, "contribute");
      return idem(caller, "create_plan", opts.idempotencyKey, input, () =>
        createPlan(svc, caller, input),
      );
    },

    async startChange(mc, input, opts) {
      // Idempotent in the coordinator (same change, fresh grant); never store push grants.
      const caller = await scoped(
        mc,
        { repoId: input.repoId, planId: input.planId ?? undefined },
        "contribute",
      );
      return startChange(svc, caller, input, opts.idempotencyKey);
    },

    async getChangeStatus(mc, changeId) {
      const d = await getChangeDetail(svc, await scoped(mc, { changeId }), changeId);
      return {
        change: d.change,
        runs: d.runs,
        classification: d.classification
          ? {
              lane: d.classification.lane,
              computedLane: d.classification.computedLane,
              reasons: d.classification.reasons,
              shadow: d.classification.shadow,
              blocked: d.classification.blocked,
              requiresHumanApproval: d.classification.requiresHumanApproval,
            }
          : null,
      };
    },

    async getEvidence(mc, changeId) {
      return getChangeEvidence(svc, await scoped(mc, { changeId }), changeId);
    },

    async getTour(mc, changeId) {
      return getChangeTour(svc, await scoped(mc, { changeId }), changeId);
    },

    async requestReview(mc, changeId, message, opts) {
      const caller = await scoped(mc, { changeId });
      return idem(
        caller,
        "request_review",
        opts.idempotencyKey,
        { changeId, message: message ?? null },
        () => requestReview(svc, caller, changeId, message),
      );
    },

    async listIssuesForChange(mc, changeId) {
      return listChangeIssues(svc, await scoped(mc, { changeId }), changeId);
    },

    async refreshPushToken(mc, changeId) {
      // A fresh grant per call is safe to retry; grants are never stored.
      return refreshPushGrant(svc, await scoped(mc, { changeId }, "contribute"), changeId);
    },

    async waitForChange(mc, changeId, until, timeoutMs) {
      const caller = await scoped(mc, { changeId });
      await requireChange(svc, changeId);
      return svc.coordinator.waitFor(caller.principal, changeId, until, timeoutMs);
    },

    async listMembers(mc, repoId) {
      return listMembers(svc, await scoped(mc, { repoId }), repoId);
    },

    errorEnvelope(err) {
      return toErrorResponse(err).body;
    },
  };
}
