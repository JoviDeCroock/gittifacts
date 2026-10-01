/**
 * The platform's `McpBackend`: every tool goes through the same service functions as the HTTP
 * routes (src/services/*), so rules live in one place. Mutating tools are idempotent per
 * (principal, idempotencyKey) through the same store as the `Idempotency-Key` header.
 */
import { Principal } from "@app/domain";
import type { McpBackend, McpCaller } from "@app/mcp";
import type { Caller, Services } from "../app-env.js";
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
      callerFrom(mc);
      return listRepoSummaries(svc);
    },

    async createPlan(mc, input, opts) {
      const caller = callerFrom(mc);
      return idem(caller, "create_plan", opts.idempotencyKey, input, () =>
        createPlan(svc, caller, input),
      );
    },

    async startChange(mc, input, opts) {
      const caller = callerFrom(mc);
      return idem(caller, "start_change", opts.idempotencyKey, input, () =>
        startChange(svc, caller, input, opts.idempotencyKey),
      );
    },

    async getChangeStatus(mc, changeId) {
      callerFrom(mc);
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
      callerFrom(mc);
      return getChangeEvidence(svc, changeId);
    },

    async getTour(mc, changeId) {
      callerFrom(mc);
      return getChangeTour(svc, changeId);
    },

    async requestReview(mc, changeId, message, opts) {
      const caller = callerFrom(mc);
      return idem(
        caller,
        "request_review",
        opts.idempotencyKey,
        { changeId, message: message ?? null },
        () => requestReview(svc, caller, changeId, message),
      );
    },

    async listIssuesForChange(mc, changeId) {
      callerFrom(mc);
      return listChangeIssues(svc, changeId);
    },

    async refreshPushToken(mc, changeId, opts) {
      const caller = callerFrom(mc);
      return idem(caller, "refresh_push_token", opts.idempotencyKey, { changeId }, () =>
        refreshPushGrant(svc, caller, changeId),
      );
    },

    async waitForChange(mc, changeId, until, timeoutMs) {
      const caller = callerFrom(mc);
      await requireChange(svc, changeId);
      return svc.coordinator.waitFor(caller.principal, changeId, until, timeoutMs);
    },

    errorEnvelope(err) {
      return toErrorResponse(err).body;
    },
  };
}
