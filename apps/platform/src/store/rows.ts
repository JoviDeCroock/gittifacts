/**
 * Row ↔ domain mapping. Every row read from D1 is zod-parsed into the domain type here, so a
 * corrupt or drifted row fails loudly at the boundary instead of leaking into the coordinator.
 */
import { type ClassifyResult, GATES } from "@app/classifier";
import {
  Change,
  Lane,
  LaneReason,
  LinkedIssue,
  PipelineRun,
  Plan,
  Principal,
  PrincipalKey,
  Repo,
  RepoPolicy,
  ReviewDecision,
  Scope,
} from "@app/domain";
import { z } from "zod";
import type * as s from "../db/schema.js";

export class StoreDataError extends Error {
  override readonly name = "StoreDataError";
}

export function parseRow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new StoreDataError(
      `${what}: stored row does not match the domain schema: ${r.error.message}`,
    );
  }
  return r.data;
}

type RepoRow = typeof s.repos.$inferSelect;
type PlanRow = typeof s.plans.$inferSelect;
type ChangeRow = typeof s.changes.$inferSelect;
type RunRow = typeof s.pipelineRuns.$inferSelect;
type ReviewRow = typeof s.reviews.$inferSelect;
type IssueRow = typeof s.issues.$inferSelect;
type PrincipalRow = typeof s.principals.$inferSelect;
type PrincipalKeyRow = typeof s.principalKeys.$inferSelect;

// ---------------------------------------------------------------- repos

export function repoFromRow(r: RepoRow): Repo {
  return parseRow(
    Repo,
    {
      id: r.id,
      namespace: r.namespace,
      artifactsName: r.artifactsName,
      name: r.name,
      defaultBranch: r.defaultBranch,
      jurisdiction: r.jurisdiction,
      importedFrom: r.importedFrom,
      policy: parseRow(RepoPolicy, r.policy, `repo ${r.id} policy`),
      policySha: r.policySha,
      deployTarget: r.deployTarget,
      ...(r.flagshipAppId === null ? {} : { flagshipAppId: r.flagshipAppId }),
      claim: { status: r.claimStatus, ownerId: r.claimOwnerId, expiresAt: r.claimExpiresAt },
      template: r.template,
      ...(r.host == null ? {} : { host: r.host }),
      createdAt: r.createdAt,
    },
    `repo ${r.id}`,
  );
}

export function repoToRow(
  repo: Repo,
  createdBy: string | null = null,
): typeof s.repos.$inferInsert {
  const v = Repo.parse(repo);
  return {
    id: v.id,
    namespace: v.namespace,
    artifactsName: v.artifactsName,
    name: v.name,
    defaultBranch: v.defaultBranch,
    jurisdiction: v.jurisdiction,
    importedFrom: v.importedFrom,
    policy: v.policy,
    policySha: v.policySha,
    deployTarget: v.deployTarget,
    flagshipAppId: v.flagshipAppId ?? null,
    claimStatus: v.claim.status,
    claimOwnerId: v.claim.ownerId,
    claimExpiresAt: v.claim.expiresAt,
    template: v.template,
    host: v.host ?? null,
    createdBy,
    createdAt: v.createdAt,
  };
}

// ---------------------------------------------------------------- plans

export function planFromRow(r: PlanRow): Plan {
  return parseRow(
    Plan,
    {
      id: r.id,
      repoId: r.repoId,
      title: r.title,
      intent: r.intent,
      acceptanceCriteria: r.acceptanceCriteria,
      outOfScope: r.outOfScope,
      riskDeclarations: r.riskDeclarations,
      scopePaths: r.scopePaths,
      affectedRoutes: r.affectedRoutes,
      status: r.status,
      authorId: r.authorId,
      approvedBy: r.approvedBy,
      approvedAt: r.approvedAt,
      approvalSignature: r.approvalSignature,
      supersedes: r.supersedes,
      createdAt: r.createdAt,
    },
    `plan ${r.id}`,
  );
}

/** Plan as the API returns it: the domain Plan plus who rejected it, when and why. */
export type PlanView = Plan & {
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
};

export function planViewFromRow(r: PlanRow): PlanView {
  const plan = planFromRow(r);
  const rejected = plan.status === "rejected";
  return {
    ...plan,
    rejectedBy: rejected ? r.decidedBy : null,
    rejectedAt: rejected ? (r.decidedAt ?? r.updatedAt) : null,
    rejectionReason: rejected ? r.decisionComment : null,
  };
}

export function planToRow(plan: Plan, extra: { approvalKeyId?: string | null; updatedAt: string }) {
  const v = Plan.parse(plan);
  return {
    id: v.id,
    repoId: v.repoId,
    title: v.title,
    intent: v.intent,
    acceptanceCriteria: v.acceptanceCriteria,
    outOfScope: v.outOfScope,
    riskDeclarations: v.riskDeclarations,
    scopePaths: v.scopePaths,
    affectedRoutes: v.affectedRoutes,
    status: v.status,
    authorId: v.authorId,
    approvedBy: v.approvedBy,
    approvedAt: v.approvedAt,
    approvalSignature: v.approvalSignature,
    approvalKeyId: extra.approvalKeyId ?? null,
    supersedes: v.supersedes,
    createdAt: v.createdAt,
    updatedAt: extra.updatedAt,
  } satisfies typeof s.plans.$inferInsert;
}

// ---------------------------------------------------------------- changes

export function changeFromRow(r: ChangeRow): Change {
  return parseRow(
    Change,
    {
      id: r.id,
      repoId: r.repoId,
      planId: r.planId,
      title: r.title,
      claim: { category: r.claimCategory, summary: r.claimSummary },
      baseSha: r.baseSha,
      headSha: r.headSha,
      forkName: r.forkName,
      authorId: r.authorId,
      status: r.status,
      computedLane: r.computedLane,
      lane: r.lane,
      laneReasons: r.laneReasons,
      evidenceId: r.evidenceId,
      tourId: r.tourId,
      flagKey: r.flagKey,
      mergedSha: r.mergedSha,
      rolloutState: r.rolloutState ?? null,
      revertOf: r.revertOf,
      revertedBy: r.revertedBy,
      agentTraceId: r.agentTraceId,
      ...(r.host == null ? {} : { host: r.host }),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    },
    `change ${r.id}`,
  );
}

export function changeToRow(change: Change): typeof s.changes.$inferInsert {
  const v = Change.parse(change);
  return {
    id: v.id,
    repoId: v.repoId,
    planId: v.planId,
    title: v.title,
    claimCategory: v.claim.category,
    claimSummary: v.claim.summary,
    baseSha: v.baseSha,
    headSha: v.headSha,
    forkName: v.forkName,
    authorId: v.authorId,
    status: v.status,
    computedLane: v.computedLane,
    lane: v.lane,
    laneReasons: v.laneReasons,
    evidenceId: v.evidenceId,
    tourId: v.tourId,
    flagKey: v.flagKey,
    mergedSha: v.mergedSha,
    rolloutState: v.rolloutState,
    rolloutVersionId: v.rolloutState?.versionId ?? null,
    revertOf: v.revertOf,
    revertedBy: v.revertedBy,
    agentTraceId: v.agentTraceId,
    host: v.host ?? null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

// ---------------------------------------------------------------- runs, reviews, issues

export function runFromRow(r: RunRow): PipelineRun {
  return parseRow(
    PipelineRun,
    {
      id: r.id,
      changeId: r.changeId,
      headSha: r.headSha,
      engine: r.engine,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      steps: r.steps,
    },
    `run ${r.id}`,
  );
}

export function reviewFromRow(r: ReviewRow): ReviewDecision {
  return parseRow(
    ReviewDecision,
    {
      id: r.id,
      changeId: r.changeId,
      headSha: r.headSha,
      reviewerId: r.reviewerId,
      decision: r.decision,
      humanLane: r.humanLane,
      computedLane: r.computedLane,
      comment: r.comment,
      createdAt: r.createdAt,
    },
    `review ${r.id}`,
  );
}

export function issueFromRow(r: IssueRow): LinkedIssue {
  return parseRow(
    LinkedIssue,
    {
      id: r.id,
      changeId: r.changeId,
      title: r.title,
      count: r.count,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      versionId: r.versionId,
      url: r.url,
    },
    `issue ${r.id}`,
  );
}

// ---------------------------------------------------------------- principals

export function principalFromRows(r: PrincipalRow, keys: PrincipalKeyRow[]): Principal {
  return parseRow(
    Principal,
    {
      id: r.id,
      kind: r.kind,
      name: r.name,
      ownerId: r.ownerId,
      scopes: z.array(Scope).parse(r.scopes),
      ...(r.kind === "agent" || r.kind === "integration" ? { repoIds: r.repoIds ?? null } : {}),
      keys: keys.map((k) =>
        parseRow(
          PrincipalKey,
          {
            id: k.id,
            alg: k.alg,
            publicKey: k.publicKey,
            createdAt: k.createdAt,
            revokedAt: k.revokedAt,
          },
          `principal key ${k.id}`,
        ),
      ),
    },
    `principal ${r.id}`,
  );
}

// ---------------------------------------------------------------- classification

/** zod mirror of `@app/classifier`'s ClassifyResult (an interface there). */
export const ClassifyResultSchema = z.object({
  lane: Lane,
  computedLane: Lane,
  reasons: z.array(LaneReason),
  shadow: z.boolean(),
  blocked: z.boolean(),
  requiresHumanApproval: z.boolean(),
  checklist: z.array(
    z.object({
      gate: z.enum(GATES),
      passed: z.boolean().nullable(),
      detail: z.string(),
    }),
  ),
});

export function classificationFromJson(value: unknown, what: string): ClassifyResult {
  return parseRow(ClassifyResultSchema, value, what);
}

// Compile-time guard: the zod mirror and the classifier's interface must stay identical.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _classifyResultInSync: Same<z.output<typeof ClassifyResultSchema>, ClassifyResult> = true;
void _classifyResultInSync;
