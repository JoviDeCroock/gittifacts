/**
 * External integrations (docs/prompts/04-integrations.md): deploy platforms register an OAuth app
 * ("integration"), people install it on repositories, and it clones, receives webhooks and reports
 * deployments. Three audiences share this client:
 *   - the developer portal (`/api/v1/integrations…`, the integration's owner),
 *   - the install screen (`/api/v1/integration-installs/{id}`, the human deciding),
 *   - installed integrations (`/api/v1/installations…`, per human or org).
 *
 * In mock mode the calls go to ./mock-integrations.ts.
 */
import { ApiError, type ErrorFix, type Method, request } from "./client.js";
import { isMockMode } from "./mode.js";

export type IntegrationScope =
  | "repo:read"
  | "contents:read"
  | "webhooks"
  | "deployments:write"
  | "checks:write";

export type WebhookEvent =
  | "push"
  | "change.created"
  | "change.updated"
  | "change.merged"
  | "change.reverted"
  | "installation.created"
  | "installation.deleted"
  | "ping";

export interface ScopeExplained {
  scope: IntegrationScope;
  title: string;
  description: string;
}

export type ClientType = "confidential" | "public";

export interface SecretView {
  id: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface WebhookConfig {
  url: string | null;
  active: boolean;
  events: WebhookEvent[];
  secretSet: boolean;
}

export interface IntegrationView {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string;
  redirectUris: string[];
  clientType: ClientType;
  scopes: IntegrationScope[];
  /** The same scopes in the server's plain words (what people see on the install screen). */
  scopesExplained: ScopeExplained[];
  /** Who people see as the developer ("by …"). */
  developer: { name: string };
  webhook: WebhookConfig;
  secrets: SecretView[];
  installationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationInput {
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  homepageUrl: string;
  redirectUris: string[];
  clientType?: ClientType;
  scopes: IntegrationScope[];
  webhook?: { url: string | null; events: WebhookEvent[]; active?: boolean; secret?: string };
}

export type DeliveryStatus = "pending" | "delivered" | "failed" | "cancelled";

export interface DeliverySummary {
  id: string;
  guid: string;
  event: WebhookEvent;
  action: string | null;
  repo: { id: string; name: string } | null;
  installationId: string | null;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  redeliveryOf: string | null;
}

export interface DeliveryDetail extends DeliverySummary {
  url: string;
  requestHeaders: Record<string, string>;
  /** Raw JSON body, exactly as signed. */
  payload: string;
  /** First 2 KB of the response. */
  responseBody: string | null;
  error: string | null;
}

export type InstallStatus = "pending" | "approved" | "denied" | "redeemed" | "expired";
export type RepoSelection = "all" | "selected";

export interface RepoRef {
  id: string;
  name: string;
  fullName: string;
}

export interface InstallView {
  id: string;
  status: InstallStatus;
  integration: {
    id: string;
    clientId: string;
    name: string;
    description: string | null;
    logoUrl: string | null;
    homepageUrl: string;
    homepageHost: string;
    developer: { name: string };
    clientType: ClientType;
  };
  redirectHost: string;
  scopes: ScopeExplained[];
  never: string[];
  /** Repositories you may install on: claimed, and you own or maintain them. */
  repos: RepoRef[];
  existing: { installationId: string; repoSelection: RepoSelection; repoIds: string[] } | null;
  expiresAt: string;
}

export interface InstallDecision {
  repoSelection: RepoSelection;
  repoIds: string[];
}

export interface InstallationView {
  id: string;
  integration: {
    id: string;
    name: string;
    logoUrl: string | null;
    homepageUrl: string;
    developer: { name: string };
  };
  account: { id: string; kind: "human" | "org"; handle: string };
  scopes: ScopeExplained[];
  repoSelection: RepoSelection;
  repos: RepoRef[];
  /** Claimed repositories the account owns or maintains: the choices for "Change repositories". */
  eligibleRepos: RepoRef[];
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  installedBy: { id: string; name: string };
}

// ---------------------------------------------------------------- transport

function readFix(err: Record<string, unknown>): ErrorFix | null {
  const fix = err.fix;
  if (typeof fix !== "object" || fix === null) return null;
  const f = fix as Record<string, unknown>;
  if (typeof f.explanation !== "string") return null;
  return {
    explanation: f.explanation,
    ...(typeof f.call === "string" ? { call: f.call } : {}),
    ...(typeof f.command === "string" ? { command: f.command } : {}),
    ...(typeof f.docsUrl === "string" ? { docsUrl: f.docsUrl } : {}),
  };
}

async function call<T>(method: Method, path: string, body?: unknown, key?: string): Promise<T> {
  if (!isMockMode()) return request<T>(method, path, body, key);
  const mock = await import("./mock-integrations.js");
  const res = await mock.handle(method, path, body);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  const err =
    typeof res.body === "object" && res.body !== null && "error" in res.body
      ? ((res.body as { error: Record<string, unknown> }).error ?? {})
      : {};
  throw new ApiError(
    res.status,
    typeof err.code === "string" ? err.code : `http_${res.status}`,
    typeof err.message === "string" ? err.message : `The server answered ${res.status}.`,
    err.details,
    readFix(err),
  );
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

const base = (id: string) => `/api/v1/integrations/${enc(id)}`;

export interface CreatedIntegration {
  integration: IntegrationView;
  /** Shown once; null for public (PKCE) clients. */
  clientSecret: string | null;
  /** Generated when a webhook URL was given without a secret; shown once. */
  webhookSecret: string | null;
}

export interface DeliveryFilter {
  status?: DeliveryStatus;
  event?: WebhookEvent;
  limit?: number;
}

export const integrationsApi = {
  // developer portal (the integration's owner)
  list: () => call<{ integrations: IntegrationView[] }>("GET", "/api/v1/integrations"),
  create: (input: IntegrationInput, key?: string) =>
    call<CreatedIntegration>("POST", "/api/v1/integrations", input, key),
  get: (id: string) => call<{ integration: IntegrationView }>("GET", base(id)),
  update: (id: string, patch: Partial<IntegrationInput>, key?: string) =>
    call<{ integration: IntegrationView }>("PATCH", base(id), patch, key),
  remove: (id: string, key?: string) =>
    call<{ deleted: true; uninstalled: number }>("DELETE", base(id), undefined, key),
  createSecret: (id: string, key?: string) =>
    call<{ clientSecret: string; secret: SecretView; integration: IntegrationView }>(
      "POST",
      `${base(id)}/secrets`,
      undefined,
      key,
    ),
  revokeSecret: (id: string, secretId: string, key?: string) =>
    call<{ integration: IntegrationView }>(
      "DELETE",
      `${base(id)}/secrets/${enc(secretId)}`,
      undefined,
      key,
    ),
  rotateWebhookSecret: (id: string, key?: string) =>
    call<{ webhookSecret: string; integration: IntegrationView }>(
      "POST",
      `${base(id)}/webhook-secret`,
      undefined,
      key,
    ),
  ping: (id: string, key?: string) =>
    call<{ delivery: DeliverySummary }>("POST", `${base(id)}/ping`, undefined, key),
  deliveries: (id: string, f: DeliveryFilter = {}) =>
    call<{ deliveries: DeliverySummary[] }>(
      "GET",
      `${base(id)}/deliveries${query({ status: f.status, event: f.event, limit: f.limit })}`,
    ),
  delivery: (id: string, deliveryId: string) =>
    call<{ delivery: DeliveryDetail }>("GET", `${base(id)}/deliveries/${enc(deliveryId)}`),
  redeliver: (id: string, deliveryId: string, key?: string) =>
    call<{ delivery: DeliverySummary }>(
      "POST",
      `${base(id)}/deliveries/${enc(deliveryId)}/redeliver`,
      undefined,
      key,
    ),

  // install screen (the human deciding)
  install: (requestId: string) =>
    call<{ install: InstallView }>("GET", `/api/v1/integration-installs/${enc(requestId)}`),
  approveInstall: (requestId: string, d: InstallDecision, key?: string) =>
    call<{ redirectTo: string }>(
      "POST",
      `/api/v1/integration-installs/${enc(requestId)}/approve`,
      d,
      key,
    ),
  denyInstall: (requestId: string, key?: string) =>
    call<{ redirectTo: string }>(
      "POST",
      `/api/v1/integration-installs/${enc(requestId)}/deny`,
      undefined,
      key,
    ),

  // installed integrations (per human or org)
  installations: () => call<{ installations: InstallationView[] }>("GET", "/api/v1/installations"),
  updateInstallation: (id: string, d: InstallDecision, key?: string) =>
    call<{ installation: InstallationView }>("PATCH", `/api/v1/installations/${enc(id)}`, d, key),
  uninstall: (id: string, key?: string) =>
    call<{ installation: InstallationView }>(
      "POST",
      `/api/v1/installations/${enc(id)}/uninstall`,
      undefined,
      key,
    ),
};
