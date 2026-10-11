/**
 * The dashboard's getting-started checklist (`GET /api/v1/me/getting-started`): the golden path
 * (DECISIONS 2026-10-11) as facts about a signed-in human, read from real state, so each step
 * ticks itself off:
 *
 *   projects    1. a repo: from a template or an import (any repo the human is a member of)
 *   agent       2. an agent the human owns can act: a token or an OAuth / device session (claiming
 *               an agent's project transfers that agent to the claimer, so a claim counts too),
 *               or an agent already wrote a Plan or a Change in one of the human's repos
 *   plan        3. the human approved a Plan; until then, the Plan to approve (the newest draft
 *               sample Plan create_project drafted, else any draft)
 *   review      4. the human approved a Change; until then, the Change waiting for review
 *   firstMerge  5. the first Change (not a bootstrap) the merge queue landed in the human's repos,
 *               with its time-to-first-merge when the repo came from create_project
 *
 * plus, read by the repo step's quiet lines:
 *
 *   firstGreen  the first green check on one of the human's repos: a create_project bootstrap that
 *               went green with its preview serving (project_onboarding), else any passed CI run
 *   repo        a repo brought from elsewhere: imported (from a URL or by push), mirrored from
 *               GitHub, or a GitHub App installation the human linked
 *   latestBootstrap  the newest create_project bootstrap, so the step can show its run while it
 *               is still going
 *
 * Every query is scoped to the caller's own memberships.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import {
  agentTokens,
  changes,
  githubInstallationLinks,
  pipelineRuns,
  plans,
  principals,
  projectOnboarding,
  repoMembers,
  repos,
  reviews,
} from "../db/schema.js";
import { previewUrlFor, previewZone } from "../previews/ids.js";
import { firstGreenMs } from "../projects/onboarding.js";

const Bootstrap = z.object({
  projectId: z.string(),
  projectName: z.string(),
  template: z.string().nullable(),
  changeId: z.string().nullable(),
  previewUrl: z.string().nullable(),
  createdAt: z.string(),
  status: z
    .enum(["running", "green", "ci-failed", "preview-failed", "no-preview"])
    .describe("running until the first CI run and preview finish"),
  msToFirstGreen: z
    .number()
    .nullable()
    .describe("create_project → CI green and the preview serving (green only)"),
});

export const GettingStartedSchema = z
  .object({
    projects: z.number().int().describe("Repos you are a member of"),
    agent: z.object({
      connected: z.boolean(),
      name: z.string().nullable().describe("The newest connected agent"),
    }),
    firstGreen: z
      .object({
        projectId: z.string(),
        projectName: z.string(),
        changeId: z.string(),
        previewUrl: z.string().nullable(),
        at: z.string().nullable(),
        msToFirstGreen: z.number().nullable(),
      })
      .nullable(),
    latestBootstrap: Bootstrap.nullable(),
    repo: z.object({
      connected: z.boolean(),
      via: z.enum(["import", "github-mirror", "github-app"]).nullable(),
    }),
    plan: z
      .object({
        approved: z.boolean().describe("You approved a Plan"),
        planId: z.string().describe("The Plan you approved, else the one to approve"),
        title: z.string(),
        status: z.enum(["draft", "approved", "superseded", "rejected"]),
        repoId: z.string(),
        repoName: z.string(),
        sample: z.boolean().describe("The sample Plan create_project drafted"),
      })
      .nullable()
      .describe("Null: no Plan to approve yet (none drafted in your repos)"),
    review: z
      .object({
        approved: z.boolean().describe("You approved a Change"),
        changeId: z.string(),
        title: z.string(),
        status: z.string(),
        repoId: z.string(),
      })
      .nullable()
      .describe("The Change you approved, else the newest one waiting for review; null: neither"),
    firstMerge: z
      .object({
        projectId: z.string(),
        projectName: z.string(),
        changeId: z.string(),
        title: z.string(),
        at: z.string().nullable(),
        msToFirstMerge: z
          .number()
          .nullable()
          .describe("create_project → this merge (repos made with create_project only)"),
      })
      .nullable(),
  })
  .meta({ id: "GettingStarted" });
export type GettingStarted = z.infer<typeof GettingStartedSchema>;

type OnboardingRow = typeof projectOnboarding.$inferSelect;

function bootstrapStatus(row: OnboardingRow): z.infer<typeof Bootstrap>["status"] {
  const o = row.outcome;
  return o === "green" || o === "ci-failed" || o === "preview-failed" || o === "no-preview"
    ? o
    : "running";
}

function msToFirstGreen(row: OnboardingRow): number | null {
  return firstGreenMs({
    projectId: row.projectId,
    template: row.template,
    outcome: row.outcome,
    createdAt: row.createdAt,
    msToRespond: row.msToRespond,
    msToGreen: row.msToGreen,
    msToPreview: row.msToPreview,
  });
}

/** D1 caps bound parameters per statement; query long id lists in slices. */
async function chunked<T>(ids: readonly string[], run: (slice: string[]) => Promise<T[]>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) out.push(...(await run(ids.slice(i, i + 90))));
  return out;
}

async function connectedAgent(svc: Services, ownerId: string, now: string) {
  const rows = await svc.store.db
    .select({ name: principals.name, createdAt: principals.createdAt })
    .from(principals)
    .innerJoin(agentTokens, eq(agentTokens.principalId, principals.id))
    .where(
      and(
        eq(principals.ownerId, ownerId),
        eq(principals.kind, "agent"),
        isNull(principals.disabledAt),
        isNull(agentTokens.revokedAt),
        or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, now)),
      ),
    )
    .orderBy(desc(principals.createdAt))
    .limit(1)
    .all();
  return rows[0]?.name ?? null;
}

/**
 * A passed CI run on a Change of these repos (imports and GitHub mirrors have no bootstrap row).
 * Bootstrap Changes are left out: their first green is the onboarding row's (CI green *and* the
 * preview serving), and their CI passes before the preview is up.
 */
async function anyPassedRun(svc: Services, repoIds: readonly string[]) {
  const rows = await chunked(repoIds, (slice) =>
    svc.store.db
      .select({
        repoId: changes.repoId,
        changeId: changes.id,
        finishedAt: pipelineRuns.finishedAt,
      })
      .from(pipelineRuns)
      .innerJoin(changes, eq(changes.id, pipelineRuns.changeId))
      .where(
        and(
          inArray(changes.repoId, slice),
          eq(pipelineRuns.status, "passed"),
          notExists(
            svc.store.db
              .select({ one: sql`1` })
              .from(projectOnboarding)
              .where(eq(projectOnboarding.bootstrapChangeId, changes.id)),
          ),
        ),
      )
      .orderBy(pipelineRuns.finishedAt)
      .limit(1)
      .all(),
  );
  return rows.sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))[0] ?? null;
}

/** Not a bootstrap Change (create_project's first CI run of the initial commit). */
function notBootstrap(svc: Services) {
  return notExists(
    svc.store.db
      .select({ one: sql`1` })
      .from(projectOnboarding)
      .where(eq(projectOnboarding.bootstrapChangeId, changes.id)),
  );
}

/** The newest agent that wrote a Plan or a Change in these repos (an agent that acted). */
async function agentThatActed(svc: Services, repoIds: readonly string[]) {
  const db = svc.store.db;
  const rows = await chunked(repoIds, async (slice) => [
    ...(await db
      .select({ name: principals.name, at: changes.createdAt })
      .from(changes)
      .innerJoin(principals, eq(principals.id, changes.authorId))
      .where(and(inArray(changes.repoId, slice), eq(principals.kind, "agent")))
      .orderBy(desc(changes.createdAt))
      .limit(1)
      .all()),
    ...(await db
      .select({ name: principals.name, at: plans.createdAt })
      .from(plans)
      .innerJoin(principals, eq(principals.id, plans.authorId))
      .where(and(inArray(plans.repoId, slice), eq(principals.kind, "agent")))
      .orderBy(desc(plans.createdAt))
      .limit(1)
      .all()),
  ]);
  return rows.sort((a, b) => b.at.localeCompare(a.at))[0]?.name ?? null;
}

type PlanRow = Pick<typeof plans.$inferSelect, "id" | "title" | "status" | "repoId" | "createdAt">;

/** Step 3: the Plan the human approved (newest), else the Plan to approve (sample Plans first). */
async function planStep(
  svc: Services,
  me: string,
  repoIds: readonly string[],
  nameOf: ReadonlyMap<string, string>,
  sampleIds: ReadonlySet<string>,
): Promise<GettingStarted["plan"]> {
  const db = svc.store.db;
  const cols = {
    id: plans.id,
    title: plans.title,
    status: plans.status,
    repoId: plans.repoId,
    createdAt: plans.createdAt,
  };
  const approved = await chunked(repoIds, (slice) =>
    db
      .select(cols)
      .from(plans)
      .where(and(inArray(plans.repoId, slice), eq(plans.approvedBy, me)))
      .orderBy(desc(plans.approvedAt))
      .limit(1)
      .all(),
  );
  const out = (p: PlanRow, isApproved: boolean): NonNullable<GettingStarted["plan"]> => ({
    approved: isApproved,
    planId: p.id,
    title: p.title,
    status: p.status,
    repoId: p.repoId,
    repoName: nameOf.get(p.repoId) ?? p.repoId,
    sample: sampleIds.has(p.id),
  });
  const mine = approved.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (mine !== undefined) return out(mine, true);
  const drafts = await chunked(repoIds, (slice) =>
    db
      .select(cols)
      .from(plans)
      .where(and(inArray(plans.repoId, slice), eq(plans.status, "draft")))
      .orderBy(desc(plans.createdAt))
      .limit(20)
      .all(),
  );
  const newest = drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pick = newest.find((p) => sampleIds.has(p.id)) ?? newest[0];
  return pick === undefined ? null : out(pick, false);
}

/** Step 4: the newest Change the human approved, else the newest one waiting for review. */
async function reviewStep(
  svc: Services,
  me: string,
  repoIds: readonly string[],
): Promise<GettingStarted["review"]> {
  const db = svc.store.db;
  const cols = {
    changeId: changes.id,
    title: changes.title,
    status: changes.status,
    repoId: changes.repoId,
    at: changes.updatedAt,
  };
  const approved = await chunked(repoIds, (slice) =>
    db
      .select(cols)
      .from(reviews)
      .innerJoin(changes, eq(changes.id, reviews.changeId))
      .where(
        and(
          inArray(changes.repoId, slice),
          eq(reviews.reviewerId, me),
          eq(reviews.decision, "approve"),
          isNull(reviews.withdrawnAt),
        ),
      )
      .orderBy(desc(reviews.createdAt))
      .limit(1)
      .all(),
  );
  const view = (c: (typeof approved)[number], isApproved: boolean) => ({
    approved: isApproved,
    changeId: c.changeId,
    title: c.title,
    status: c.status,
    repoId: c.repoId,
  });
  const mine = approved.sort((a, b) => b.at.localeCompare(a.at))[0];
  if (mine !== undefined) return view(mine, true);
  const waiting = await chunked(repoIds, (slice) =>
    db
      .select(cols)
      .from(changes)
      .where(and(inArray(changes.repoId, slice), eq(changes.status, "awaiting-review")))
      .orderBy(desc(changes.updatedAt))
      .limit(1)
      .all(),
  );
  const next = waiting.sort((a, b) => b.at.localeCompare(a.at))[0];
  return next === undefined ? null : view(next, false);
}

/**
 * Step 5: the first merge. A create_project repo's recorded first merge (with its
 * time-to-first-merge) wins; else the oldest merged non-bootstrap Change of these repos.
 */
async function firstMergeStep(
  svc: Services,
  repoIds: readonly string[],
  nameOf: ReadonlyMap<string, string>,
  onboarding: readonly OnboardingRow[],
): Promise<GettingStarted["firstMerge"]> {
  const db = svc.store.db;
  const recorded = onboarding
    .filter((r) => r.firstMergeChangeId !== null && r.firstMergedAt !== null)
    .sort((a, b) => (a.firstMergedAt ?? "").localeCompare(b.firstMergedAt ?? ""))[0];
  if (recorded?.firstMergeChangeId) {
    const change = await svc.store.getChange(recorded.firstMergeChangeId);
    return {
      projectId: recorded.projectId,
      projectName: nameOf.get(recorded.projectId) ?? recorded.projectId,
      changeId: recorded.firstMergeChangeId,
      title: change?.title ?? recorded.firstMergeChangeId,
      at: recorded.firstMergedAt,
      msToFirstMerge: recorded.msToFirstMerge,
    };
  }
  const rows = await chunked(repoIds, (slice) =>
    db
      .select({
        changeId: changes.id,
        repoId: changes.repoId,
        title: changes.title,
        at: changes.updatedAt,
      })
      .from(changes)
      .where(and(inArray(changes.repoId, slice), isNotNull(changes.mergedSha), notBootstrap(svc)))
      .orderBy(changes.updatedAt)
      .limit(1)
      .all(),
  );
  const first = rows.sort((a, b) => a.at.localeCompare(b.at))[0];
  if (first === undefined) return null;
  return {
    projectId: first.repoId,
    projectName: nameOf.get(first.repoId) ?? first.repoId,
    changeId: first.changeId,
    title: first.title,
    at: first.at,
    msToFirstMerge: null,
  };
}

export async function gettingStarted(svc: Services, caller: Caller): Promise<GettingStarted> {
  const me = caller.principal.id;
  const db = svc.store.db;
  const now = new Date().toISOString();
  const memberRepos = await db
    .select({
      id: repos.id,
      name: repos.name,
      importedFrom: repos.importedFrom,
      host: repos.host,
    })
    .from(repoMembers)
    .innerJoin(repos, eq(repos.id, repoMembers.repoId))
    .where(eq(repoMembers.principalId, me))
    .all();
  const ids = memberRepos.map((r) => r.id);
  const nameOf = new Map(memberRepos.map((r) => [r.id, r.name]));

  const [agentName, onboarding, links] = await Promise.all([
    connectedAgent(svc, me, now),
    chunked(ids, (slice) =>
      db.select().from(projectOnboarding).where(inArray(projectOnboarding.projectId, slice)).all(),
    ),
    db
      .select({ id: githubInstallationLinks.installationId })
      .from(githubInstallationLinks)
      .where(eq(githubInstallationLinks.principalId, me))
      .limit(1)
      .all(),
  ]);

  // The golden path's steps 2–5 (step 1 is `projects`).
  const sampleIds = new Set(onboarding.flatMap((r) => (r.samplePlanId ? [r.samplePlanId] : [])));
  const [actedName, plan, review, firstMerge] = await Promise.all([
    agentName === null && ids.length > 0 ? agentThatActed(svc, ids) : Promise.resolve(null),
    planStep(svc, me, ids, nameOf, sampleIds),
    reviewStep(svc, me, ids),
    firstMergeStep(svc, ids, nameOf, onboarding),
  ]);
  const agent = agentName ?? actedName;

  const zone = previewZone(svc.env);
  const previewOf = (row: OnboardingRow) =>
    row.bootstrapChangeId === null || row.outcome === "no-preview"
      ? null
      : previewUrlFor(zone, row.bootstrapChangeId);
  const byNewest = [...onboarding].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = byNewest[0];
  // Oldest first: green with its preview, else a finished bootstrap whose CI passed (a template
  // without a preview, or a preview that failed), else a passed run on any other Change.
  const finished = [...byNewest].reverse().filter((r) => r.bootstrapChangeId !== null);
  const bootstrapGreen =
    finished.find((r) => r.outcome === "green") ??
    finished.find((r) => r.outcome === "no-preview" || r.outcome === "preview-failed");

  let firstGreen: GettingStarted["firstGreen"] = null;
  if (bootstrapGreen?.bootstrapChangeId) {
    firstGreen = {
      projectId: bootstrapGreen.projectId,
      projectName: nameOf.get(bootstrapGreen.projectId) ?? bootstrapGreen.projectId,
      changeId: bootstrapGreen.bootstrapChangeId,
      previewUrl: bootstrapGreen.outcome === "green" ? previewOf(bootstrapGreen) : null,
      at: bootstrapGreen.previewReadyAt ?? bootstrapGreen.evidenceAt,
      msToFirstGreen: msToFirstGreen(bootstrapGreen),
    };
  } else if (ids.length > 0) {
    const run = await anyPassedRun(svc, ids);
    if (run !== null) {
      firstGreen = {
        projectId: run.repoId,
        projectName: nameOf.get(run.repoId) ?? run.repoId,
        changeId: run.changeId,
        previewUrl: null,
        at: run.finishedAt,
        msToFirstGreen: null,
      };
    }
  }

  const imported = memberRepos.find((r) => r.importedFrom !== null && r.importedFrom !== "");
  const mirrored = memberRepos.find((r) => r.host !== null);
  const pushImport = onboarding.find((r) => r.source === "import");
  const via = mirrored
    ? "github-mirror"
    : links.length > 0
      ? "github-app"
      : imported || pushImport
        ? "import"
        : null;

  return {
    projects: memberRepos.length,
    agent: { connected: agent !== null, name: agent },
    firstGreen,
    latestBootstrap:
      latest === undefined
        ? null
        : {
            projectId: latest.projectId,
            projectName: nameOf.get(latest.projectId) ?? latest.projectId,
            template: latest.template,
            changeId: latest.bootstrapChangeId,
            previewUrl: previewOf(latest),
            createdAt: latest.createdAt,
            status: bootstrapStatus(latest),
            msToFirstGreen: msToFirstGreen(latest),
          },
    repo: { connected: via !== null, via },
    plan,
    review,
    firstMerge,
  };
}
