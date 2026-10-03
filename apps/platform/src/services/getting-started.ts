/**
 * The dashboard's getting-started checklist (`GET /api/v1/me/getting-started`): three facts about
 * a signed-in human, read from real state, so each step ticks itself off.
 *
 *   agent       an agent the human owns can act: a token or an OAuth / device session (claiming
 *               an agent's project transfers that agent to the claimer, so a claim counts too)
 *   firstGreen  the first green check on one of the human's repos: a create_project bootstrap that
 *               went green with its preview serving (project_onboarding), else any passed CI run
 *   repo        a repo brought from elsewhere: imported (from a URL or by push), mirrored from
 *               GitHub, or a GitHub App installation the human linked
 *
 * plus the newest create_project bootstrap of the human's repos, so the "Try it now" step can show
 * its run while it is still going. Every query is scoped to the caller's own memberships.
 */
import { and, desc, eq, gt, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import {
  agentTokens,
  changes,
  githubInstallationLinks,
  pipelineRuns,
  principals,
  projectOnboarding,
  repoMembers,
  repos,
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
    agent: { connected: agentName !== null, name: agentName },
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
  };
}
