/**
 * Deployments API: deploy platforms report what they deployed (they never deploy *for* us).
 *
 *   POST /api/v1/repos/{repoId}/deployments           { sha, environment, changeId?, ref?, description? }
 *   POST /api/v1/deployments/{deploymentId}/statuses  { state, url?, logUrl?, description? }
 *
 * - Only an integration token with `deployments:write`, on a repo of its installation, may report;
 *   never on an unclaimed project.
 * - A successful **preview** becomes signed `preview` evidence on its Change (./evidence.ts).
 * - Every report is audit-logged. Change-bound reports go to `change:<id>`, which is the Change's
 *   rollout timeline: a production deployment (success, or failure with its log link) shows there.
 *   Without a Change, a production deployment of a merged commit is matched by `mergedSha`.
 */
import { Sha } from "@app/evidence";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assertRepoAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import {
  changes,
  deploymentStatuses,
  deployments,
  installations,
  integrations,
} from "../db/schema.js";
import { ApiError, forbidden, notFound } from "../errors.js";
import { attachPreview, type DeploymentRow } from "./evidence.js";

const Url = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");

export const DeploymentInput = z
  .object({
    sha: Sha,
    environment: z.enum(["preview", "production"]),
    /** The Change this preview is for (a preview of its fork head). Production: optional. */
    changeId: z.string().min(1).max(64).optional(),
    ref: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional(),
  })
  .meta({ id: "DeploymentInput" });

export const DeploymentState = z.enum(["queued", "in_progress", "success", "failure", "error"]);

export const DeploymentStatusInput = z
  .object({
    state: DeploymentState,
    url: Url.optional(),
    logUrl: Url.optional(),
    description: z.string().max(1000).optional(),
  })
  .meta({ id: "DeploymentStatusInput" });

const StatusView = z.object({
  id: z.string(),
  state: DeploymentState,
  url: z.string().nullable(),
  logUrl: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
});

export const DeploymentViewSchema = z
  .object({
    id: z.string(),
    repoId: z.string(),
    changeId: z.string().nullable(),
    environment: z.enum(["preview", "production"]),
    sha: z.string(),
    ref: z.string().nullable(),
    state: z.enum(["pending", "queued", "in_progress", "success", "failure", "error"]),
    url: z.string().nullable(),
    logUrl: z.string().nullable(),
    description: z.string().nullable(),
    integration: z.object({ id: z.string(), name: z.string() }),
    installationId: z.string(),
    evidence: z.object({
      status: z.enum(["none", "pending", "attached"]),
      itemId: z.string().nullable(),
    }),
    statuses: z.array(StatusView),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Deployment" });
export type DeploymentView = z.infer<typeof DeploymentViewSchema>;

export const DeploymentListQuery = z.object({
  environment: z.enum(["preview", "production"]).optional(),
  changeId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function views(svc: Services, rows: DeploymentRow[]): Promise<DeploymentView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [statuses, names] = await Promise.all([
    svc.store.db
      .select()
      .from(deploymentStatuses)
      .where(inArray(deploymentStatuses.deploymentId, ids))
      .orderBy(asc(deploymentStatuses.createdAt))
      .all(),
    svc.store.db
      .select({ id: integrations.id, name: integrations.name })
      .from(integrations)
      .where(inArray(integrations.id, [...new Set(rows.map((r) => r.integrationId))]))
      .all(),
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((d) => ({
    id: d.id,
    repoId: d.repoId,
    changeId: d.changeId,
    environment: d.environment,
    sha: d.sha,
    ref: d.ref,
    state: d.state,
    url: d.url,
    logUrl: d.logUrl,
    description: d.description,
    integration: { id: d.integrationId, name: nameOf.get(d.integrationId) ?? d.integrationId },
    installationId: d.installationId,
    evidence: { status: d.evidenceStatus, itemId: d.evidenceItemId },
    statuses: statuses
      .filter((s) => s.deploymentId === d.id)
      .map((s) => ({
        id: s.id,
        state: s.state,
        url: s.url,
        logUrl: s.logUrl,
        description: s.description,
        createdAt: s.createdAt,
      })),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));
}

function requireIntegration(caller: Caller): void {
  if (caller.principal.kind !== "integration") {
    throw forbidden(
      "only an installed integration reports deployments",
      { kind: caller.principal.kind },
      {
        explanation:
          "Deploy platforms report with the access token from the integration install flow (scope deployments:write).",
      },
    );
  }
}

async function installationOf(svc: Services, caller: Caller) {
  const inst = await svc.store.db
    .select()
    .from(installations)
    .where(eq(installations.principalId, caller.principal.id))
    .get();
  if (inst?.status !== "active")
    throw forbidden("this installation was removed", undefined, {
      explanation:
        "The repo owner uninstalled this integration, so its tokens no longer report deployments. Ask them to install it again.",
    });
  return inst;
}

/** The Change a report is about: given (and in this repo), or inferred from the sha. */
async function changeFor(
  svc: Services,
  repoId: string,
  sha: string,
  environment: "preview" | "production",
  changeId: string | undefined,
): Promise<string | null> {
  if (changeId !== undefined) {
    const change = await svc.store.getChange(changeId);
    if (!change || change.repoId !== repoId) {
      throw notFound(`change ${changeId} in repo ${repoId}`, {
        explanation: "Use the change id from the webhook payload (change.id) of this repository.",
      });
    }
    return change.id;
  }
  const col = environment === "production" ? changes.mergedSha : changes.headSha;
  const rows = await svc.store.db
    .select({ id: changes.id })
    .from(changes)
    .where(and(eq(changes.repoId, repoId), eq(col, sha)))
    .orderBy(desc(changes.updatedAt))
    .limit(2)
    .all();
  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

export async function createDeployment(
  svc: Services,
  caller: Caller,
  repoId: string,
  input: z.infer<typeof DeploymentInput>,
): Promise<DeploymentView> {
  requireIntegration(caller);
  // The chokepoint: reader on the installation's repos while the installer is still a member.
  const repo = await assertRepoAccess(svc, caller.principal, repoId, "read");
  if (repo.claim.status !== "claimed") {
    throw new ApiError(
      403,
      "unclaimed-project",
      "unclaimed projects can't take deployment reports",
      { repoId },
      {
        explanation: "Integrations can't be connected to unclaimed projects; claim it first.",
      },
    );
  }
  const inst = await installationOf(svc, caller);
  const changeId = await changeFor(svc, repoId, input.sha, input.environment, input.changeId);
  const now = svc.clock.now().toISOString();
  const row: DeploymentRow = {
    id: `dpl_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    repoId,
    changeId,
    installationId: inst.id,
    integrationId: inst.integrationId,
    principalId: caller.principal.id,
    sha: input.sha,
    ref: input.ref ?? null,
    environment: input.environment,
    state: "pending",
    url: null,
    logUrl: null,
    description: input.description ?? null,
    evidenceStatus: "none",
    evidenceItemId: null,
    createdAt: now,
    updatedAt: now,
  };
  await svc.store.db.insert(deployments).values(row);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "deployment.created",
    subject: changeId ? `change:${changeId}` : `repo:${repoId}`,
    payload: {
      summary: `${input.environment === "production" ? "Production" : "Preview"} deployment of ${input.sha.slice(0, 12)} started by ${caller.principal.name}`,
      deploymentId: row.id,
      repoId,
      environment: input.environment,
      sha: input.sha,
      installationId: inst.id,
    },
  });
  const [view] = await views(svc, [row]);
  if (!view) throw new Error("deployment view missing");
  return view;
}

async function ownDeployment(svc: Services, caller: Caller, id: string): Promise<DeploymentRow> {
  requireIntegration(caller);
  const d = await svc.store.db.select().from(deployments).where(eq(deployments.id, id)).get();
  if (!d || d.principalId !== caller.principal.id) {
    throw notFound(`deployment ${id}`, {
      explanation: "Report statuses for deployments this installation created.",
    });
  }
  return d;
}

function statusSummary(
  d: DeploymentRow,
  who: string,
  state: string,
  url: string | null,
  logUrl: string | null,
): string {
  const env = d.environment === "production" ? "Production" : "Preview";
  const what = `${env} deployment of ${d.sha.slice(0, 12)} by ${who}: ${state.replace("_", " ")}`;
  if (state === "success" && url) return `${what}: ${url}`;
  if ((state === "failure" || state === "error") && logUrl) return `${what} (log: ${logUrl})`;
  return what;
}

export async function addDeploymentStatus(
  svc: Services,
  caller: Caller,
  deploymentId: string,
  input: z.infer<typeof DeploymentStatusInput>,
): Promise<DeploymentView> {
  const d = await ownDeployment(svc, caller, deploymentId);
  await installationOf(svc, caller);
  await assertRepoAccess(svc, caller.principal, d.repoId, "read");
  const now = svc.clock.now().toISOString();
  await svc.store.db.insert(deploymentStatuses).values({
    id: `dps_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    deploymentId,
    state: input.state,
    url: input.url ?? null,
    logUrl: input.logUrl ?? null,
    description: input.description ?? null,
    createdAt: now,
  });
  const patch = {
    state: input.state,
    url: input.url ?? d.url,
    logUrl: input.logUrl ?? d.logUrl,
    description: input.description ?? d.description,
    updatedAt: now,
  };
  await svc.store.db.update(deployments).set(patch).where(eq(deployments.id, deploymentId));
  const row: DeploymentRow = { ...d, ...patch };
  await svc.audit.append({
    principalId: caller.principal.id,
    action: d.environment === "production" ? "deployment.production" : "deployment.preview",
    subject: d.changeId ? `change:${d.changeId}` : `repo:${d.repoId}`,
    payload: {
      summary: statusSummary(d, caller.principal.name, input.state, row.url, row.logUrl),
      deploymentId,
      repoId: d.repoId,
      environment: d.environment,
      sha: d.sha,
      state: input.state,
      url: row.url,
      logUrl: row.logUrl,
    },
  });
  if (row.environment === "preview" && row.state === "success" && row.changeId !== null) {
    await attachPreview({ store: svc.store, signer: await svc.signer() }, row);
  }
  const after = await svc.store.db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .get();
  const [view] = await views(svc, [after ?? row]);
  if (!view) throw new Error("deployment view missing");
  return view;
}

export async function getDeployment(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<DeploymentView> {
  const d = await svc.store.db.select().from(deployments).where(eq(deployments.id, id)).get();
  const p = caller.principal;
  // An integration sees only its own deployments; everyone (integrations too) needs read on the
  // deployment's repo. Any refusal is the same 404 as an unknown id.
  if (!d || (p.kind === "integration" && d.principalId !== p.id)) {
    throw notFound(`deployment ${id}`);
  }
  try {
    await assertRepoAccess(svc, p, d.repoId, "read");
  } catch (e) {
    if (e instanceof ApiError) throw notFound(`deployment ${id}`);
    throw e;
  }
  const [view] = await views(svc, [d]);
  if (!view) throw notFound(`deployment ${id}`);
  return view;
}

/** Deployments of a repo (route-level repo:read + repo grant already checked). */
export async function listDeployments(
  svc: Services,
  repoId: string,
  q: z.infer<typeof DeploymentListQuery>,
): Promise<DeploymentView[]> {
  const conds = [eq(deployments.repoId, repoId)];
  if (q.environment) conds.push(eq(deployments.environment, q.environment));
  if (q.changeId) conds.push(eq(deployments.changeId, q.changeId));
  const rows = await svc.store.db
    .select()
    .from(deployments)
    .where(and(...conds))
    .orderBy(desc(deployments.createdAt))
    .limit(q.limit)
    .all();
  return views(svc, rows);
}
