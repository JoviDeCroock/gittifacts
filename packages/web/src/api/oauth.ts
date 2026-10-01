/**
 * Delegated agent auth (onboarding O4): consent for OAuth clients (`/oauth/consent`), device
 * logins (`/device`), and the human's agent sessions (Agents screen).
 *
 * Shapes mirror the platform's `ConsentView` and `AgentSession` schemas
 * (apps/platform/src/oauth/{consent,sessions}.ts). In mock mode the calls go to ./mock-oauth.ts.
 */
import type { Scope } from "@app/domain";
import { ApiError, type ErrorFix, request } from "./client.js";
import { isMockMode } from "./mode.js";

export type ConsentFlow = "authorization_code" | "device_code";
export type ConsentStatus = "pending" | "approved" | "denied" | "redeemed" | "expired";

export interface ConsentView {
  flow: ConsentFlow;
  /** Request id (code flow) or user code (device flow). */
  id: string;
  status: ConsentStatus;
  client: {
    id: string;
    name: string;
    uri: string | null;
    /** The domain that vouches for the client (Client ID Metadata Document); null for the CLI. */
    host: string | null;
    kind: "first-party" | "cimd";
  };
  /** Where the browser returns after the decision (code flow). */
  redirectHost: string | null;
  requestedScopes: Scope[];
  audience: { uri: string; label: string }[];
  expiresAt: string;
  repos: { id: string; name: string }[];
  grantableScopes: Scope[];
  neverScopes: Scope[];
  sessionDayChoices: number[];
  defaultSessionDays: number;
}

export interface ConsentDecision {
  scopes: Scope[];
  /** Specific repos, or null for every repo (an explicit choice). */
  repoIds: string[] | null;
  sessionDays: number;
  name?: string;
}

export interface AgentSession {
  principalId: string;
  name: string;
  flow: "authorization_code" | "device_code" | "manual";
  client: { id: string; name: string; uri: string | null } | null;
  scopes: Scope[];
  repoIds: string[] | null;
  repos: { id: string; name: string }[];
  audience: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  status: "active" | "expired" | "revoked";
  revokedAt: string | null;
  activeTokens: number;
  tokenPrefix: string | null;
}

type Method = "GET" | "POST";

function readFix(err: Record<string, unknown>): ErrorFix | null {
  const fix = err.fix;
  if (typeof fix !== "object" || fix === null) return null;
  const f = fix as Record<string, unknown>;
  if (typeof f.explanation !== "string") return null;
  return {
    explanation: f.explanation,
    ...(typeof f.call === "string" ? { call: f.call } : {}),
    ...(typeof f.command === "string" ? { command: f.command } : {}),
  };
}

async function call<T>(method: Method, path: string, body?: unknown, key?: string): Promise<T> {
  if (!isMockMode()) return request<T>(method, path, body, key);
  const mock = await import("./mock-oauth.js");
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

export const oauthApi = {
  consent: (requestId: string) =>
    call<{ consent: ConsentView }>("GET", `/api/v1/oauth/requests/${enc(requestId)}`),
  approve: (requestId: string, d: ConsentDecision, key?: string) =>
    call<{ redirectTo: string }>(
      "POST",
      `/api/v1/oauth/requests/${enc(requestId)}/approve`,
      d,
      key,
    ),
  deny: (requestId: string, key?: string) =>
    call<{ redirectTo: string }>(
      "POST",
      `/api/v1/oauth/requests/${enc(requestId)}/deny`,
      undefined,
      key,
    ),

  device: (userCode: string) =>
    call<{ consent: ConsentView }>("GET", `/api/v1/oauth/device/${enc(userCode)}`),
  approveDevice: (userCode: string, d: ConsentDecision, key?: string) =>
    call<{ status: "approved" }>("POST", `/api/v1/oauth/device/${enc(userCode)}/approve`, d, key),
  denyDevice: (userCode: string, key?: string) =>
    call<{ status: "denied" }>(
      "POST",
      `/api/v1/oauth/device/${enc(userCode)}/deny`,
      undefined,
      key,
    ),

  sessions: () => call<{ sessions: AgentSession[] }>("GET", "/api/v1/agent-sessions"),
  revokeSession: (principalId: string, key?: string) =>
    call<{ session: AgentSession }>(
      "POST",
      `/api/v1/agent-sessions/${enc(principalId)}/revoke`,
      {},
      key,
    ),
};
