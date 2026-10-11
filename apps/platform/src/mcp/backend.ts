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
import { pageUrl } from "@app/conventions";
import { type Change, Principal, type ReviewDecision } from "@app/domain";
import type { ChangeReviewData, McpBackend, McpCaller } from "@app/mcp";
import { z } from "zod";
import { type AccessTarget, assertTargetAccess } from "../access/access.js";
import { listMembers } from "../access/members.js";
import type { RepoNeed } from "../access/roles.js";
import type { Caller, Services } from "../app-env.js";
import { anonymousWhoami } from "../claim/anonymous.js";
import { createUnclaimedProject } from "../claim/create.js";
import { toErrorResponse, unauthorized } from "../errors.js";
import { resolveGithubChangeId } from "../github/refs.js";
import { runIdempotent } from "../idempotency.js";
import { createImportMcpBackend } from "../import/mcp.js";
import type { AnonymousClient } from "../limits/client.js";
import { qaBrief } from "../qa/brief.js";
import { createQueueMcpBackend } from "../queue/mcp.js";
import { capabilities } from "../services/capabilities.js";
import {
  closeChange,
  getChangeDetail,
  getChangeEvidence,
  getChangeTour,
  listChangeIssues,
  listChangeReviews,
  listChangeSummaries,
  refreshPushGrant,
  requestReview,
  requireChange,
  rerunChangeCi,
  startChange,
} from "../services/changes.js";
import { getChangeOverlaps } from "../services/overlaps.js";
import { createPlan, getPlanDetail, listPlans, withdrawPlan } from "../services/plans.js";
import { createProject } from "../services/projects.js";
import { listQaRuns, requestQaFor } from "../services/qa.js";
import { listRepoSummaries } from "../services/repos.js";
import type { PrincipalRef } from "../store/d1-store.js";
import { createWorkspaceMcpBackend } from "../workspace/mcp.js";

/** `authInfo.clientId` of a caller without credentials (src/mcp/route.ts). */
export const ANONYMOUS_CLIENT_ID = "anonymous";

const AnonymousExtra = z.object({
  ipHash: z.string().min(1),
  asn: z.number().int().nullable(),
  country: z.string().nullable(),
  /** Set by src/limits/client.ts only when the eval-traffic signature verified. */
  evalRun: z.string().min(1).nullable().optional(),
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

/** A review as agents read it, with the reviewer's name and kind. */
function reviewData(r: ReviewDecision, principals: Record<string, PrincipalRef>): ChangeReviewData {
  const who = principals[r.reviewerId];
  return {
    id: r.id,
    decision: r.decision,
    comment: r.comment,
    headSha: r.headSha,
    reviewer: { id: r.reviewerId, name: who?.name ?? r.reviewerId, kind: who?.kind ?? "human" },
    at: r.createdAt,
    withdrawn: r.withdrawn == null ? null : { at: r.withdrawn.at, reason: r.withdrawn.reason },
  };
}

/** The current head's preview once it answered: the `preview` item of its sealed evidence. */
async function previewUrlOf(svc: Services, change: Change): Promise<string | null> {
  if (change.headSha === null || change.evidenceId === null) return null;
  try {
    const evidence = await svc.store.getEvidence(change.id, change.headSha);
    const item = evidence?.items.find((i) => i.kind === "preview");
    return item?.kind === "preview" && item.status === "ok" && item.url ? item.url : null;
  } catch {
    return null; // informational: never fail the status call over it
  }
}

/** Open changes on the same plan or paths; null when the check failed (never fails the status). */
async function overlapsOf(svc: Services, caller: Caller, changeId: string) {
  try {
    return await getChangeOverlaps(svc, caller, changeId);
  } catch (err) {
    console.warn("get_change_status: overlap check failed", err);
    return null;
  }
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

    webUrl(page) {
      return pageUrl(svc.origin, page);
    },

    async getPlan(mc, planId) {
      return getPlanDetail(svc, await scoped(mc, { planId }), planId);
    },

    async listChanges(mc, repoId, filter) {
      const caller = await scoped(mc, { repoId });
      const { changes } = await listChangeSummaries(svc, caller, repoId, {
        statuses: filter.status === undefined ? undefined : [filter.status],
      });
      return changes;
    },

    async listPlans(mc, repoId) {
      return listPlans(svc, await scoped(mc, { repoId }), repoId);
    },

    async withdrawPlan(mc, planId, reason, opts) {
      const caller = await scoped(mc, { planId });
      return idem(
        caller,
        "withdraw_plan",
        opts.idempotencyKey,
        { planId, reason: reason ?? null },
        () => withdrawPlan(svc, caller, planId, { reason }),
      );
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

    async resolveGithubChange(mc, ref) {
      const { changeId, repoId } = await resolveGithubChangeId(svc.store.db, ref);
      // Same answer as an unknown repo for someone who can't read this one.
      await scoped(mc, { repoId });
      return changeId;
    },

    async getChangeStatus(mc, changeId) {
      const caller = await scoped(mc, { changeId });
      const [d, r] = await Promise.all([
        getChangeDetail(svc, caller, changeId),
        listChangeReviews(svc, caller, changeId),
      ]);
      return {
        previewUrl: await previewUrlOf(svc, d.change),
        overlaps: await overlapsOf(svc, caller, changeId),
        reviews: r.reviews.map((x) => reviewData(x, r.principals)),
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

    async rerunCi(mc, changeId, reason, opts) {
      const caller = await scoped(mc, { changeId });
      return idem(
        caller,
        "rerun_ci",
        opts.idempotencyKey,
        { changeId, reason: reason ?? null },
        () => rerunChangeCi(svc, caller, changeId, reason),
      );
    },

    async closeChange(mc, changeId, reason, opts) {
      const caller = await scoped(mc, { changeId });
      return idem(
        caller,
        "close_change",
        opts.idempotencyKey,
        { changeId, reason: reason ?? null },
        () => closeChange(svc, caller, changeId, reason),
      );
    },

    async requestQa(mc, changeId, input, opts) {
      const caller = await scoped(mc, { changeId }, "contribute");
      const out = await idem(
        caller,
        "request_qa",
        opts.idempotencyKey,
        { changeId, force: input.force === true },
        () =>
          requestQaFor(svc, caller, changeId, {
            trigger: "mcp",
            ...(input.force === true ? { force: true } : {}),
          }),
      );
      return { run: qaBrief(out.run, svc.origin), reused: out.reused };
    },

    async listQa(mc, changeId) {
      const runs = await listQaRuns(svc, await scoped(mc, { changeId }), changeId);
      return runs.slice(0, 5).map((r) => qaBrief(r, svc.origin));
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
