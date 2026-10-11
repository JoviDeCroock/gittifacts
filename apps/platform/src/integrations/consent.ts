/**
 * The install screen (`/integrations/install?request=…`): what the integration asks for in plain
 * words, the repo picker, and the decision. Only a signed-in human sees or decides a request; the
 * first one to open it owns it. Repos must be ones the human may install on (claimed, owned);
 * unclaimed projects never appear and are refused if named.
 */
import { IntegrationScope } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { installationRepos, integrationAuthorizations, principals } from "../db/schema.js";
import { ApiError, forbidden, notFound } from "../errors.js";
import { errorRedirect, randomId } from "../oauth/authorize.js";
import type { OAuthUrls } from "../oauth/urls.js";
import { canInstallOn, installableRepos } from "./access.js";
import { emitInstallationEvent } from "./events.js";
import { handleFor, repoNames } from "./handles.js";
import {
  type AuthorizationRow,
  bindAuthorization,
  type InstallDecisionBody,
  requestedScopesOf,
} from "./install.js";
import { activeInstallation, upsertInstallation } from "./installations.js";
import { getIntegration } from "./registry.js";
import { eventDepsFor } from "./runtime.js";
import { explainScopes, NEVER_WORDS, ScopeExplainedSchema } from "./scopes.js";

/** One-time codes live this long after approval. */
export const INSTALL_CODE_TTL_MS = 5 * 60_000;

const RepoRef = z.object({ id: z.string(), name: z.string(), fullName: z.string() });

export const InstallViewSchema = z
  .object({
    id: z.string(),
    status: z.enum(["pending", "approved", "denied", "redeemed", "expired"]),
    integration: z.object({
      id: z.string(),
      clientId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      logoUrl: z.string().nullable(),
      homepageUrl: z.string(),
      homepageHost: z.string(),
      developer: z.object({ name: z.string() }),
      clientType: z.enum(["confidential", "public"]),
    }),
    redirectHost: z.string(),
    scopes: z.array(ScopeExplainedSchema),
    never: z.array(z.string()),
    repos: z.array(RepoRef),
    existing: z
      .object({
        installationId: z.string(),
        repoSelection: z.enum(["all", "selected"]),
        repoIds: z.array(z.string()),
        scopes: z
          .array(IntegrationScope)
          .describe("What the installation already granted: an update marks what it adds"),
      })
      .nullable(),
    expiresAt: z.string(),
  })
  .meta({ id: "IntegrationInstallView" });
export type InstallView = z.infer<typeof InstallViewSchema>;

function requireHuman(caller: Caller): void {
  if (caller.principal.kind !== "human") {
    throw forbidden(
      "only a signed-in human can install integrations",
      { kind: caller.principal.kind },
      {
        explanation:
          "Agents and integrations can never install integrations. Send the person the install link.",
      },
    );
  }
}

async function load(svc: Services, caller: Caller, id: string): Promise<AuthorizationRow> {
  requireHuman(caller);
  const find = () =>
    svc.store.db
      .select()
      .from(integrationAuthorizations)
      .where(eq(integrationAuthorizations.id, id))
      .get();
  let row = await find();
  if (!row) {
    throw notFound("install request", {
      explanation:
        "This link is invalid or was already used. Start the connection again from the deploy platform.",
    });
  }
  if (row.ownerId === null) {
    await bindAuthorization(svc, id, caller.principal.id);
    row = await find();
    if (!row) throw notFound("install request");
  }
  if (row.ownerId !== caller.principal.id) {
    throw forbidden("this install request belongs to another signed-in person", undefined, {
      explanation:
        "Only the person who opened the link first can decide it. Start again from the deploy platform.",
    });
  }
  return row;
}

function statusOf(row: AuthorizationRow, now: Date): InstallView["status"] {
  if (row.status === "pending" && Date.parse(row.expiresAt) <= now.getTime()) return "expired";
  return row.status;
}

function assertPending(row: AuthorizationRow, now: Date): void {
  const s = statusOf(row, now);
  if (s === "expired") {
    throw new ApiError(409, "invalid-state", "this install request expired", undefined, {
      explanation:
        "Install requests last 10 minutes. Start the connection again from the deploy platform.",
    });
  }
  if (s !== "pending") {
    throw new ApiError(409, "invalid-state", `this install request was already ${s}`, undefined, {
      explanation:
        "Each request can be decided once. Start again from the deploy platform if needed.",
    });
  }
}

async function integrationOf(svc: Services, row: AuthorizationRow) {
  const integration = await getIntegration(svc, row.integrationId);
  if (!integration) {
    throw notFound("integration", { explanation: "The integration was deleted by its developer." });
  }
  return integration;
}

export async function getInstallRequest(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<InstallView> {
  const row = await load(svc, caller, id);
  const integration = await integrationOf(svc, row);
  const developer = await svc.store.db
    .select({ name: principals.name })
    .from(principals)
    .where(eq(principals.id, integration.ownerId))
    .get();
  const repos = await installableRepos(svc, caller.principal);
  const refs = [];
  for (const r of repos) {
    const names = await repoNames(svc, r);
    if (names) refs.push({ id: r.id, name: r.name, fullName: names.fullName });
  }
  const existing = await activeInstallation(svc, integration.id, caller.principal.id);
  let existingView: InstallView["existing"] = null;
  if (existing) {
    const rows = await svc.store.db
      .select({ repoId: installationRepos.repoId })
      .from(installationRepos)
      .where(eq(installationRepos.installationId, existing.id))
      .all();
    existingView = {
      installationId: existing.id,
      repoSelection: existing.repoSelection,
      repoIds: rows.map((r) => r.repoId),
      scopes: IntegrationScope.array().catch([]).parse(existing.scopes),
    };
  }
  return {
    id: row.id,
    status: statusOf(row, svc.clock.now()),
    integration: {
      id: integration.id,
      clientId: integration.clientId,
      name: integration.name,
      description: integration.description,
      logoUrl: integration.logoUrl,
      homepageUrl: integration.homepageUrl,
      homepageHost: new URL(integration.homepageUrl).host,
      developer: { name: developer?.name ?? "unknown developer" },
      clientType: integration.clientType,
    },
    redirectHost: new URL(row.redirectUri).host || row.redirectUri,
    scopes: explainScopes(requestedScopesOf(row)),
    never: [...NEVER_WORDS],
    repos: refs,
    existing: existingView,
    expiresAt: row.expiresAt,
  };
}

export async function approveInstall(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  id: string,
  body: InstallDecisionBody,
): Promise<{ redirectTo: string; installationId: string }> {
  const row = await load(svc, caller, id);
  const now = svc.clock.now();
  assertPending(row, now);
  const integration = await integrationOf(svc, row);
  const repoIds = [...new Set(body.repoIds)];
  if (body.repoSelection === "selected") {
    if (repoIds.length === 0) {
      throw new ApiError(400, "invalid-request", "pick at least one repository", undefined, {
        explanation: "Choose repositories, or install on all repositories you own.",
      });
    }
    for (const repoId of repoIds) {
      const repo = await svc.store.getRepo(repoId);
      if (!repo || !(await canInstallOn(svc.store, caller.principal, repo))) {
        throw new ApiError(
          403,
          "repo-not-installable",
          `you cannot connect integrations to repo ${repoId}`,
          { repoId },
          {
            explanation:
              repo?.claim.status === "unclaimed"
                ? "Unclaimed projects can't be connected to integrations. Claim the project first."
                : "Only a repository's owners and maintainers can connect integrations to it. Pick from the install screen's list.",
          },
        );
      }
    }
  }
  const scopes = requestedScopesOf(row);
  const { installation, created } = await upsertInstallation(
    svc,
    caller.principal,
    integration,
    scopes,
    body.repoSelection,
    body.repoSelection === "selected" ? repoIds : [],
  );
  const code = randomId();
  const updated = await svc.store.db
    .update(integrationAuthorizations)
    .set({
      status: "approved",
      repoSelection: body.repoSelection,
      grantedRepoIds: body.repoSelection === "selected" ? repoIds : null,
      installationId: installation.id,
      codeHash: await sha256Hex(code),
      codeExpiresAt: new Date(now.getTime() + INSTALL_CODE_TTL_MS).toISOString(),
      decidedAt: now.toISOString(),
    })
    .where(
      and(eq(integrationAuthorizations.id, id), eq(integrationAuthorizations.status, "pending")),
    )
    .returning({ id: integrationAuthorizations.id });
  if (updated.length === 0) {
    throw new ApiError(409, "invalid-state", "this install request was decided concurrently");
  }
  if (created) {
    const deps = eventDepsFor(svc);
    const grant = await svc.store.getPrincipal(installation.principalId);
    const repositories = [];
    for (const repoId of grant?.repoIds ?? []) {
      const repo = await svc.store.getRepo(repoId);
      const names = repo ? await repoNames(svc, repo) : null;
      if (repo && names)
        repositories.push({
          id: repo.id,
          name: repo.name,
          fullName: names.fullName,
          cloneUrl: names.cloneUrl,
        });
    }
    await emitInstallationEvent(deps, "created", installation.id, {
      account: { id: caller.principal.id, handle: await handleFor(svc, caller.principal.id) },
      repoSelection: body.repoSelection,
      repositories,
      scopes,
    });
  }
  const u = new URL(row.redirectUri);
  u.searchParams.set("code", code);
  if (row.state !== null) u.searchParams.set("state", row.state);
  u.searchParams.set("iss", urls.issuer);
  u.searchParams.set("installation_id", installation.id);
  return { redirectTo: u.toString(), installationId: installation.id };
}

export async function denyInstall(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  id: string,
): Promise<{ redirectTo: string }> {
  const row = await load(svc, caller, id);
  const now = svc.clock.now();
  assertPending(row, now);
  await svc.store.db
    .update(integrationAuthorizations)
    .set({ status: "denied", decidedAt: now.toISOString() })
    .where(
      and(eq(integrationAuthorizations.id, id), eq(integrationAuthorizations.status, "pending")),
    );
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.install-denied",
    subject: `integration:${row.integrationId}`,
    payload: { summary: "Declined to install the integration", requestId: id },
  });
  return {
    redirectTo: errorRedirect(
      row.redirectUri,
      "access_denied",
      "the user declined the installation",
      row.state,
      urls.issuer,
    ),
  };
}
