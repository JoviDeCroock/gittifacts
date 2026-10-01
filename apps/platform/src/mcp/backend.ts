/**
 * The platform's `McpBackend`: every tool goes through the same service functions as the HTTP
 * routes (src/services/*), so rules live in one place. Mutating tools are idempotent per
 * (principal, idempotencyKey) through the same store as the `Idempotency-Key` header.
 *
 * Repo-restricted agents (delegated sessions) are checked here before any tool touches a repo,
 * plan or change outside their grant (`repo-not-granted`, see ../auth/repo-scope.ts).
 */
import { Principal } from "@app/domain";
import type { McpBackend, McpCaller } from "@app/mcp";
import type { Caller, Services } from "../app-env.js";
import { assertTargetAllowed, filterRepos, type RepoTarget } from "../auth/repo-scope.js";
import { toErrorResponse, unauthorized } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
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
import { listRepoSummaries } from "../services/repos.js";

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
  const idem = <T>(
    c: Caller,
    tool: string,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ) => runIdempotent(svc, c.principal.id, key, { method: "MCP", path: tool, body }, fn);

  /** The verified caller, after checking it may touch the repo the tool names. */
  const scoped = async (mc: Parameters<typeof callerFrom>[0], target: RepoTarget) => {
    const caller = callerFrom(mc);
    await assertTargetAllowed(svc, caller.principal, target);
    return caller;
  };

  return {
    async whoami(mc) {
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

    async listRepos(mc) {
      const caller = callerFrom(mc);
      return filterRepos(caller.principal, await listRepoSummaries(svc));
    },

    async createPlan(mc, input, opts) {
      const caller = callerFrom(mc);
      return idem(caller, "create_plan", opts.idempotencyKey, input, () =>
        createPlan(svc, caller, input),
      );
    },

    async startChange(mc, input, opts) {
      // Idempotent in the coordinator (same change, fresh grant); never store push grants.
      const caller = await scoped(mc, { repoId: input.repoId, planId: input.planId ?? undefined });
      return startChange(svc, caller, input, opts.idempotencyKey);
    },

    async getChangeStatus(mc, changeId) {
      await scoped(mc, { changeId });
      const d = await getChangeDetail(svc, changeId);
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
      await scoped(mc, { changeId });
      return getChangeEvidence(svc, changeId);
    },

    async getTour(mc, changeId) {
      await scoped(mc, { changeId });
      return getChangeTour(svc, changeId);
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
      await scoped(mc, { changeId });
      return listChangeIssues(svc, changeId);
    },

    async refreshPushToken(mc, changeId) {
      // A fresh grant per call is safe to retry; grants are never stored.
      return refreshPushGrant(svc, await scoped(mc, { changeId }), changeId);
    },

    async waitForChange(mc, changeId, until, timeoutMs) {
      const caller = await scoped(mc, { changeId });
      await requireChange(svc, changeId);
      return svc.coordinator.waitFor(caller.principal, changeId, until, timeoutMs);
    },

    errorEnvelope(err) {
      return toErrorResponse(err).body;
    },
  };
}
