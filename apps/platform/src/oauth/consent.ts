/**
 * The human side of delegation: what the consent screen (`/oauth/consent`) and the device screen
 * (`/device`) show, and the decision. Only a signed-in human can see or decide a request, and the
 * first human to open it owns it (like better-auth's device-code binding).
 *
 * A decision records the scopes (a subset of repo:read, plan:create, change:create that the human
 * holds), the repos (specific ids, or `null` = all, which the UI only sends when the human picks
 * "All repositories" explicitly), and the session length. Approval-class scopes are rejected here
 * whatever the body says.
 */
import { Id, type Repo, Scope } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { filterAccessible } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import type { Auth } from "../auth/better-auth.js";
import { deviceCode, oauthRequests } from "../db/schema.js";
import { errorRedirect, randomId } from "./authorize.js";
import { CLI_CLIENT_ID } from "./clients.js";
import { apiError } from "./errors.js";
import {
  checkGrantedScopes,
  DELEGABLE_SCOPES,
  NEVER_DELEGATED,
  parseRequestedScopes,
} from "./scopes.js";
import type { OAuthUrls } from "./urls.js";

export const SESSION_DAY_CHOICES = [1, 7, 30, 90] as const;
export const DEFAULT_SESSION_DAYS = 30;
/** One-time authorization codes live this long after approval. */
export const CODE_TTL_MS = 5 * 60_000;

export const ConsentDecisionBody = z
  .object({
    scopes: z.array(Scope).min(1).max(Scope.options.length),
    /** Specific repos, or null for every repo you can access (an explicit choice). */
    repoIds: z.array(Id).min(1).max(100).nullable(),
    sessionDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
    /** Display name for the agent; defaults to the client's name. */
    name: z.string().trim().min(1).max(120).optional(),
  })
  .meta({ id: "ConsentDecision" });
export type ConsentDecisionBody = z.infer<typeof ConsentDecisionBody>;

const RepoChoice = z.object({ id: z.string(), name: z.string() });

export const ConsentViewSchema = z
  .object({
    flow: z.enum(["authorization_code", "device_code"]),
    /** Request id (code flow) or user code (device flow). */
    id: z.string(),
    status: z.enum(["pending", "approved", "denied", "redeemed", "expired"]),
    client: z.object({
      id: z.string(),
      name: z.string(),
      uri: z.string().nullable(),
      /** The domain that vouches for the client (CIMD); null for the first-party CLI. */
      host: z.string().nullable(),
      kind: z.enum(["first-party", "cimd"]),
    }),
    /** Where the browser returns after the decision (code flow). */
    redirectHost: z.string().nullable(),
    requestedScopes: z.array(Scope),
    audience: z.array(z.object({ uri: z.string(), label: z.string() })),
    expiresAt: z.string(),
    repos: z.array(RepoChoice),
    grantableScopes: z.array(Scope),
    neverScopes: z.array(Scope),
    sessionDayChoices: z.array(z.number().int()),
    defaultSessionDays: z.number().int(),
  })
  .meta({ id: "ConsentView" });
export type ConsentView = z.infer<typeof ConsentViewSchema>;

type RequestRow = typeof oauthRequests.$inferSelect;
type DeviceRow = typeof deviceCode.$inferSelect;

function audienceLabels(urls: OAuthUrls, audience: readonly string[]) {
  return audience.map((uri) => ({
    uri,
    label: uri === urls.mcpResource ? "MCP server" : uri === urls.apiResource ? "HTTP API" : uri,
  }));
}

/**
 * Repos a human may delegate: the claimed repos they are a member of (src/access/); the agent
 * then acts with their role there. Never anyone else's repos, never unclaimed projects.
 */
export async function delegableRepos(svc: Services, caller: Caller): Promise<Repo[]> {
  const claimed = (await svc.store.listRepos()).filter((r) => r.claim.status === "claimed");
  return filterAccessible(svc, caller.principal, claimed);
}

function requireHuman(caller: Caller, urls: OAuthUrls): void {
  if (caller.principal.kind !== "human") {
    // Agents never approve anything, including new sessions for themselves.
    throw apiError(
      403,
      "forbidden",
      "only a signed-in human can approve agent access",
      urls.origin,
      {
        fix: {
          explanation:
            "Agents cannot approve OAuth or device requests (that would let an agent widen its own access). Send the human the link instead.",
        },
      },
    );
  }
}

function hostOfClientId(clientId: string): string | null {
  try {
    return new URL(clientId).host;
  } catch {
    return null;
  }
}

function baseView(
  _urls: OAuthUrls,
  caller: Caller,
  repos: readonly Repo[],
): Pick<
  ConsentView,
  "repos" | "grantableScopes" | "neverScopes" | "sessionDayChoices" | "defaultSessionDays"
> {
  return {
    repos: repos.map((r) => ({ id: r.id, name: r.name })),
    grantableScopes: DELEGABLE_SCOPES.filter((s) => caller.principal.scopes.includes(s)),
    neverScopes: [...NEVER_DELEGATED],
    sessionDayChoices: [...SESSION_DAY_CHOICES],
    defaultSessionDays: DEFAULT_SESSION_DAYS,
  };
}

interface ValidDecision {
  scopes: Scope[];
  repoIds: string[] | null;
  sessionDays: number;
  name: string | undefined;
}

async function validateDecision(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  body: ConsentDecisionBody,
): Promise<ValidDecision> {
  const check = checkGrantedScopes(body.scopes, caller.principal.scopes);
  if (!check.ok) {
    if (check.reason === "not-delegable") {
      throw apiError(
        403,
        "scope-not-allowed",
        `agents can never hold ${check.rejected.join(", ")}`,
        urls.origin,
        { details: { rejected: check.rejected, allowed: DELEGABLE_SCOPES } },
      );
    }
    if (check.reason === "not-held") {
      throw apiError(
        403,
        "scope-not-allowed",
        `you cannot delegate scopes you do not hold: ${check.rejected.join(", ")}`,
        urls.origin,
        { details: { rejected: check.rejected } },
      );
    }
    throw apiError(400, "invalid-request", "pick at least one scope", urls.origin);
  }
  let repoIds: string[] | null = null;
  if (body.repoIds !== null) {
    const allowed = new Set((await delegableRepos(svc, caller)).map((r) => r.id));
    const unique = [...new Set(body.repoIds)];
    const unknown = unique.filter((id) => !allowed.has(id));
    if (unknown.length > 0) {
      throw apiError(
        400,
        "invalid-request",
        `unknown or undelegable repo: ${unknown.join(", ")}`,
        urls.origin,
        {
          details: { unknown },
          fix: {
            explanation:
              "Pick repos from the consent screen's list (claimed repos you can access).",
          },
        },
      );
    }
    repoIds = unique;
  }
  return { scopes: check.scopes, repoIds, sessionDays: body.sessionDays, name: body.name };
}

// ---------------------------------------------------------------- authorization code

async function loadRequest(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  id: string,
): Promise<RequestRow> {
  requireHuman(caller, urls);
  const row = await svc.store.db
    .select()
    .from(oauthRequests)
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.flow, "authorization_code")))
    .get();
  if (!row) {
    throw apiError(404, "not-found", "no such authorization request", urls.origin, {
      fix: {
        explanation:
          "This link is invalid or was already used. Start the connection again from your agent or MCP client.",
      },
    });
  }
  if (row.ownerId === null) {
    // First human to open the link owns the decision.
    await svc.store.db
      .update(oauthRequests)
      .set({ ownerId: caller.principal.id })
      .where(and(eq(oauthRequests.id, id), isNull(oauthRequests.ownerId)));
    const again = await svc.store.db
      .select()
      .from(oauthRequests)
      .where(eq(oauthRequests.id, id))
      .get();
    if (!again) throw apiError(404, "not-found", "no such authorization request", urls.origin);
    return checkOwner(again, caller, urls);
  }
  return checkOwner(row, caller, urls);
}

function checkOwner(row: RequestRow, caller: Caller, urls: OAuthUrls): RequestRow {
  if (row.ownerId !== caller.principal.id) {
    throw apiError(
      403,
      "forbidden",
      "this request belongs to another signed-in person",
      urls.origin,
      {
        fix: {
          explanation:
            "Only the person who opened the link first can decide it. Start again from your agent.",
        },
      },
    );
  }
  return row;
}

function statusOf(row: RequestRow, now: Date): ConsentView["status"] {
  if (row.status === "pending" && Date.parse(row.expiresAt) <= now.getTime()) return "expired";
  return row.status;
}

export async function getAuthorizationConsent(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  id: string,
): Promise<ConsentView> {
  const row = await loadRequest(svc, urls, caller, id);
  const repos = await delegableRepos(svc, caller);
  return {
    flow: "authorization_code",
    id: row.id,
    status: statusOf(row, svc.clock.now()),
    client: {
      id: row.clientId,
      name: row.clientName,
      uri: row.clientUri,
      host: row.clientKind === "cimd" ? hostOfClientId(row.clientId) : null,
      kind: row.clientKind,
    },
    redirectHost: row.redirectUri ? new URL(row.redirectUri).host : null,
    requestedScopes: z.array(Scope).catch([]).parse(row.requestedScopes),
    audience: audienceLabels(urls, row.audience),
    expiresAt: row.expiresAt,
    ...baseView(urls, caller, repos),
  };
}

function assertPending(row: RequestRow, now: Date, urls: OAuthUrls): void {
  const status = statusOf(row, now);
  if (status === "expired") {
    throw apiError(409, "invalid-state", "this authorization request expired", urls.origin, {
      fix: { explanation: "Requests last 10 minutes. Start the connection again from your agent." },
    });
  }
  if (status !== "pending") {
    throw apiError(409, "invalid-state", `this request was already ${status}`, urls.origin, {
      fix: {
        explanation: "Each request can be decided once. Start again from your agent if needed.",
      },
    });
  }
}

export async function approveAuthorization(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  id: string,
  body: ConsentDecisionBody,
): Promise<{ redirectTo: string }> {
  const row = await loadRequest(svc, urls, caller, id);
  const now = svc.clock.now();
  assertPending(row, now, urls);
  const decision = await validateDecision(svc, urls, caller, body);
  const code = randomId();
  const updated = await svc.store.db
    .update(oauthRequests)
    .set({
      status: "approved",
      grantedScopes: decision.scopes,
      grantedRepoIds: decision.repoIds,
      sessionDays: decision.sessionDays,
      agentName: decision.name ?? null,
      codeHash: await sha256Hex(code),
      codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      decidedAt: now.toISOString(),
    })
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, "pending")))
    .returning({ id: oauthRequests.id });
  if (updated.length === 0) {
    throw apiError(409, "invalid-state", "this request was decided concurrently", urls.origin);
  }
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "oauth.consent-approved",
    subject: `principal:${caller.principal.id}`,
    payload: {
      flow: "authorization_code",
      requestId: id,
      clientId: row.clientId,
      clientName: row.clientName,
      scopes: decision.scopes,
      repoIds: decision.repoIds,
      sessionDays: decision.sessionDays,
      audience: row.audience,
    },
  });
  if (!row.redirectUri) throw new Error(`authorization request ${id} has no redirect_uri`);
  const u = new URL(row.redirectUri);
  u.searchParams.set("code", code);
  if (row.state !== null) u.searchParams.set("state", row.state);
  u.searchParams.set("iss", urls.issuer);
  return { redirectTo: u.toString() };
}

export async function denyAuthorization(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  id: string,
): Promise<{ redirectTo: string }> {
  const row = await loadRequest(svc, urls, caller, id);
  const now = svc.clock.now();
  assertPending(row, now, urls);
  await svc.store.db
    .update(oauthRequests)
    .set({ status: "denied", decidedAt: now.toISOString() })
    .where(and(eq(oauthRequests.id, id), eq(oauthRequests.status, "pending")));
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "oauth.consent-denied",
    subject: `principal:${caller.principal.id}`,
    payload: { flow: "authorization_code", requestId: id, clientId: row.clientId },
  });
  if (!row.redirectUri) throw new Error(`authorization request ${id} has no redirect_uri`);
  return {
    redirectTo: errorRedirect(
      row.redirectUri,
      "access_denied",
      "the user denied access",
      row.state,
      urls.issuer,
    ),
  };
}

// ---------------------------------------------------------------- device flow

/** better-auth normalizes default-alphabet user codes the same way (strip separators, upper-case). */
export function normalizeUserCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

const VerifyResponse = z
  .object({ status: z.string(), client_id: z.string().optional() })
  .passthrough();

async function deviceRow(svc: Services, userCode: string): Promise<DeviceRow | null> {
  const exact = await svc.store.db
    .select()
    .from(deviceCode)
    .where(eq(deviceCode.userCode, userCode))
    .get();
  if (exact) return exact;
  const norm = normalizeUserCode(userCode);
  if (norm === userCode) return null;
  return (
    (await svc.store.db.select().from(deviceCode).where(eq(deviceCode.userCode, norm)).get()) ??
    null
  );
}

function noSuchCode(urls: OAuthUrls) {
  return apiError(404, "not-found", "no such device code", urls.origin, {
    fix: {
      explanation:
        "Check the code on your terminal (8 letters/digits, dashes optional). Codes last 15 minutes; run the login again for a new one.",
    },
  });
}

/** Map the plugin's APIError bodies to our envelope. */
function fromPluginError(e: unknown, urls: OAuthUrls): never {
  const body =
    typeof e === "object" && e !== null && "body" in e ? (e as { body: unknown }).body : undefined;
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : "";
  if (error === "expired_token") {
    throw apiError(409, "invalid-state", "this device code expired", urls.origin, {
      fix: { explanation: "Run the login again on the device to get a new code." },
    });
  }
  if (error === "invalid_request") throw noSuchCode(urls);
  if (error === "access_denied") {
    throw apiError(403, "forbidden", "this device code is bound to another account", urls.origin);
  }
  throw e;
}

async function claimDevice(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  auth: Auth,
  headers: Headers,
  userCode: string,
): Promise<{ row: DeviceRow; status: string }> {
  requireHuman(caller, urls);
  if (!caller.user) {
    throw apiError(
      403,
      "forbidden",
      "approve device logins from a signed-in browser session",
      urls.origin,
    );
  }
  let verified: z.infer<typeof VerifyResponse>;
  try {
    // Binds the code to this human (first viewer wins) and tells us whether it is theirs.
    verified = VerifyResponse.parse(
      await auth.api.deviceVerify({ query: { user_code: userCode }, headers }),
    );
  } catch (e) {
    fromPluginError(e, urls);
  }
  const row = await deviceRow(svc, userCode);
  if (!row) throw noSuchCode(urls);
  if (verified.client_id === undefined || row.userId !== caller.user.id) {
    throw apiError(
      403,
      "forbidden",
      "this device code was claimed by another signed-in person",
      urls.origin,
      {
        fix: { explanation: "Run the login again on the device to get a fresh code." },
      },
    );
  }
  return { row, status: verified.status };
}

function requestedOf(row: DeviceRow): Scope[] {
  const parsed = parseRequestedScopes(row.scope);
  return parsed.ok ? parsed.scopes : [];
}

function parseAudience(raw: string | null, urls: OAuthUrls): string[] {
  const fallback = [urls.mcpResource, urls.apiResource];
  if (raw === null) return fallback;
  try {
    return z.array(z.string()).catch(fallback).parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export async function getDeviceConsent(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  auth: Auth,
  headers: Headers,
  userCode: string,
): Promise<ConsentView> {
  const { row, status } = await claimDevice(svc, urls, caller, auth, headers, userCode);
  const now = svc.clock.now();
  const clientId = row.clientId ?? "";
  const expired = row.expiresAt.getTime() <= now.getTime();
  const decided = status === "approved" || status === "denied";
  const repos = await delegableRepos(svc, caller);
  return {
    flow: "device_code",
    id: row.userCode,
    status: decided ? (status as "approved" | "denied") : expired ? "expired" : "pending",
    client: {
      id: clientId,
      name: row.clientName ?? clientId,
      uri: null,
      host: clientId === CLI_CLIENT_ID ? null : hostOfClientId(clientId),
      kind: clientId === CLI_CLIENT_ID ? "first-party" : "cimd",
    },
    redirectHost: null,
    requestedScopes: requestedOf(row),
    audience: audienceLabels(urls, parseAudience(row.audience, urls)),
    expiresAt: row.expiresAt.toISOString(),
    ...baseView(urls, caller, repos),
  };
}

export async function approveDevice(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  auth: Auth,
  headers: Headers,
  userCode: string,
  body: ConsentDecisionBody,
): Promise<{ status: "approved" }> {
  const { row, status } = await claimDevice(svc, urls, caller, auth, headers, userCode);
  const now = svc.clock.now();
  if (status !== "pending") {
    throw apiError(409, "invalid-state", `this device login was already ${status}`, urls.origin);
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw apiError(409, "invalid-state", "this device code expired", urls.origin, {
      fix: { explanation: "Run the login again on the device to get a new code." },
    });
  }
  const decision = await validateDecision(svc, urls, caller, body);
  const requestId = randomId();
  const clientId = row.clientId ?? "";
  // Record the human's choices first; the token endpoint refuses a code without them.
  const inserted = await svc.store.db
    .insert(oauthRequests)
    .values({
      id: requestId,
      flow: "device_code",
      clientId,
      clientName: row.clientName ?? clientId,
      clientUri: null,
      clientKind: clientId === CLI_CLIENT_ID ? "first-party" : "cimd",
      redirectUri: null,
      state: null,
      codeChallenge: null,
      deviceCodeId: row.id,
      audience: parseAudience(row.audience, urls),
      requestedScopes: requestedOf(row),
      status: "approved",
      ownerId: caller.principal.id,
      grantedScopes: decision.scopes,
      grantedRepoIds: decision.repoIds,
      sessionDays: decision.sessionDays,
      agentName: decision.name ?? null,
      codeHash: null,
      codeExpiresAt: null,
      sessionId: null,
      createdAt: now.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: oauthRequests.id });
  if (inserted.length === 0) {
    throw apiError(409, "invalid-state", "this device login was already decided", urls.origin);
  }
  try {
    await auth.api.deviceApprove({ body: { userCode: row.userCode }, headers });
  } catch (e) {
    await svc.store.db.delete(oauthRequests).where(eq(oauthRequests.id, requestId));
    fromPluginError(e, urls);
  }
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "oauth.consent-approved",
    subject: `principal:${caller.principal.id}`,
    payload: {
      flow: "device_code",
      requestId,
      clientId,
      clientName: row.clientName,
      scopes: decision.scopes,
      repoIds: decision.repoIds,
      sessionDays: decision.sessionDays,
    },
  });
  return { status: "approved" };
}

export async function denyDevice(
  svc: Services,
  urls: OAuthUrls,
  caller: Caller,
  auth: Auth,
  headers: Headers,
  userCode: string,
): Promise<{ status: "denied" }> {
  const { row, status } = await claimDevice(svc, urls, caller, auth, headers, userCode);
  if (status !== "pending") {
    throw apiError(409, "invalid-state", `this device login was already ${status}`, urls.origin);
  }
  try {
    await auth.api.deviceDeny({ body: { userCode: row.userCode }, headers });
  } catch (e) {
    fromPluginError(e, urls);
  }
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "oauth.consent-denied",
    subject: `principal:${caller.principal.id}`,
    payload: { flow: "device_code", clientId: row.clientId },
  });
  return { status: "denied" };
}
