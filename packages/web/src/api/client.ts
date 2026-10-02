/**
 * Typed fetch client for docs/api.md. Every call goes through `request`, which either hits the
 * network (credentials included, same origin) or the in-browser mock backend.
 *
 * Review-critical payloads (plans, tours, evidence) are validated at runtime with the domain zod
 * schemas: a malformed tour must fail loudly, never render as "proven".
 */
import type { Plan } from "@app/domain";
import type { z } from "zod";
import { isMockMode } from "./mode.js";
import type {
  ApiErrorBody,
  AuditPage,
  AuditQuery,
  Change,
  ChangeDetail,
  ChangeDiff,
  ChangeSummary,
  ClaimResult,
  ClaimView,
  CreateAgentInput,
  CreateAgentResponse,
  EvidenceResponse,
  LinkedIssue,
  MeResponse,
  PrincipalRef,
  Principal,
  RepoDetail,
  RepoSummary,
  Repo,
  ReviewInput,
  RolloutResponse,
} from "./types.js";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface ErrorFix {
  explanation: string;
  call?: string;
  command?: string;
  docsUrl?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** What the server says to do next (docs/api.md error envelope). */
  readonly fix: ErrorFix | null;

  constructor(status: number, code: string, message: string, details?: unknown, fix: ErrorFix | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.fix = fix;
  }
}

/** One key per user intent: reuse it when retrying the same action so it applies once. */
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export interface RawResponse {
  status: number;
  body: unknown;
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const err = (body as { error: unknown }).error;
  return typeof err === "object" && err !== null && "code" in err && "message" in err;
}

async function send(method: Method, path: string, body?: unknown, idempotencyKey?: string): Promise<RawResponse> {
  if (isMockMode()) {
    const mock = await import("./mock.js");
    return mock.handle(method, path, body, idempotencyKey);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["Idempotency-Key"] = idempotencyKey ?? newIdempotencyKey();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and retry.", cause);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

function readFix(err: object): ErrorFix | null {
  if (!("fix" in err)) return null;
  const fix = (err as { fix: unknown }).fix;
  if (typeof fix !== "object" || fix === null || !("explanation" in fix)) return null;
  const f = fix as Record<string, unknown>;
  if (typeof f.explanation !== "string") return null;
  return {
    explanation: f.explanation,
    ...(typeof f.call === "string" ? { call: f.call } : {}),
    ...(typeof f.command === "string" ? { command: f.command } : {}),
    ...(typeof f.docsUrl === "string" ? { docsUrl: f.docsUrl } : {}),
  };
}

export async function request<T>(method: Method, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const res = await send(method, path, body, idempotencyKey);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  if (isErrorBody(res.body)) {
    const { code, message, details } = res.body.error;
    throw new ApiError(res.status, code, message, details, readFix(res.body.error));
  }
  throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status}.`);
}

/** zod and the domain schemas load on first use, keeping them out of the entry chunk. */
const schemas = () => import("@app/domain").then((m) => ({ Evidence: m.Evidence, Plan: m.Plan, Tour: m.Tour }));

function validated<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(502, "invalid_response", `The ${what} from the server did not match the expected shape.`, result.error.issues);
  }
  return result.data;
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const api = {
  // identity
  me: () => request<MeResponse>("GET", "/api/v1/me"),
  principals: () => request<{ principals: Principal[] }>("GET", "/api/v1/principals"),
  /** GAP: not in docs/api.md. */
  principal: (id: string) => request<{ principal: PrincipalRef }>("GET", `/api/v1/principals/${enc(id)}`),
  createAgent: (input: CreateAgentInput, key?: string) => request<CreateAgentResponse>("POST", "/api/v1/principals/agents", input, key),
  revokeTokens: (id: string, key?: string) => request<{ revoked: number }>("DELETE", `/api/v1/principals/${enc(id)}/tokens`, undefined, key),

  // repos
  repos: () => request<{ repos: RepoSummary[] }>("GET", "/api/v1/repos"),
  repo: (repoId: string) => request<RepoDetail>("GET", `/api/v1/repos/${enc(repoId)}`),
  setLane0: (repoId: string, enabled: boolean, key?: string) =>
    request<{ repo: Repo }>("PATCH", `/api/v1/repos/${enc(repoId)}/lane0`, { enabled }, key),

  // plans
  repoPlans: async (repoId: string) => {
    const [res, { Plan }] = await Promise.all([request<{ plans: unknown[] }>("GET", `/api/v1/repos/${enc(repoId)}/plans`), schemas()]);
    return { plans: res.plans.map((p) => validated(Plan, p, "plan")) };
  },
  plan: async (planId: string) => {
    const [res, { Plan }] = await Promise.all([request<{ plan: unknown; changes: Change[] }>("GET", `/api/v1/plans/${enc(planId)}`), schemas()]);
    return { plan: validated(Plan, res.plan, "plan"), changes: res.changes };
  },
  approvePlan: (planId: string, comment?: string, key?: string) =>
    request<{ plan: Plan }>("POST", `/api/v1/plans/${enc(planId)}/approve`, comment ? { comment } : {}, key),
  rejectPlan: (planId: string, comment: string, key?: string) =>
    request<{ plan: Plan }>("POST", `/api/v1/plans/${enc(planId)}/reject`, { comment }, key),

  // changes
  changes: (repoId: string, filter: { status?: string; lane?: string } = {}) =>
    request<{ changes: ChangeSummary[] }>("GET", `/api/v1/repos/${enc(repoId)}/changes${query(filter)}`),
  change: (changeId: string) => request<ChangeDetail>("GET", `/api/v1/changes/${enc(changeId)}`),
  diff: (changeId: string) => request<{ diff: ChangeDiff }>("GET", `/api/v1/changes/${enc(changeId)}/diff`),
  evidence: async (changeId: string): Promise<EvidenceResponse> => {
    const [res, { Evidence }] = await Promise.all([
      request<{ evidence: unknown; verification: EvidenceResponse["verification"] }>("GET", `/api/v1/changes/${enc(changeId)}/evidence`),
      schemas(),
    ]);
    return { evidence: validated(Evidence, res.evidence, "evidence bundle"), verification: res.verification };
  },
  tour: async (changeId: string) => {
    const [res, { Tour }] = await Promise.all([request<{ tour: unknown }>("GET", `/api/v1/changes/${enc(changeId)}/tour`), schemas()]);
    return { tour: validated(Tour, res.tour, "tour") };
  },
  review: (changeId: string, input: ReviewInput, key?: string) =>
    request<{ change: Change }>("POST", `/api/v1/changes/${enc(changeId)}/review`, input, key),
  rollout: (changeId: string) => request<RolloutResponse>("GET", `/api/v1/changes/${enc(changeId)}/rollout`),
  kill: (changeId: string, reason: string, key?: string) =>
    request<{ change: Change }>("POST", `/api/v1/changes/${enc(changeId)}/kill`, { reason }, key),
  issues: (changeId: string) => request<{ issues: LinkedIssue[] }>("GET", `/api/v1/changes/${enc(changeId)}/issues`),

  // claimable projects (onboarding O3): reading a claim link needs no session; claiming does.
  claim: (token: string) => request<ClaimView>("GET", `/api/v1/claims/${enc(token)}`),
  claimProject: (token: string, turnstileToken: string, key?: string) =>
    request<ClaimResult>("POST", `/api/v1/claims/${enc(token)}`, { turnstileToken }, key),

  // audit
  audit: (q: AuditQuery = {}) =>
    request<AuditPage>("GET", `/api/v1/audit${query({ subject: q.subject, cursor: q.cursor, limit: q.limit })}`),
};

/** Resolves opaque `beforeRef` / `afterRef` / `logRef` pointers: `GET /api/v1/blobs/:ref` (docs/api.md). */
export async function artifactUrl(ref: string): Promise<string> {
  if (isMockMode()) {
    const mock = await import("./mock.js");
    return mock.artifactUrl(ref);
  }
  return `/api/v1/blobs/${enc(ref)}`;
}

export interface ErrorCopy {
  title: string;
  detail: string;
  retry: boolean;
}

/** What failed, why, and how to recover. Internal codes are never the headline. */
export function describeError(err: unknown, what = "this"): ErrorCopy {
  if (err instanceof ApiError && err.fix && err.status !== 401) {
    return { title: err.message, detail: err.fix.explanation, retry: err.status === 0 || err.status === 409 || err.status === 429 || err.status >= 500 };
  }
  if (err instanceof ApiError) {
    switch (true) {
      case err.status === 0:
        return { title: `Couldn't load ${what}`, detail: err.message, retry: true };
      case err.status === 401:
        return { title: "Your session ended", detail: "Sign in again to continue where you left off.", retry: false };
      case err.status === 403:
        return { title: `You don't have access to ${what}`, detail: `${err.message} Ask a repo admin for the scope you need.`, retry: false };
      case err.status === 404:
        return { title: `We couldn't find ${what}`, detail: "It may have been removed, or the link is wrong.", retry: false };
      case err.status === 409:
        return { title: "That action conflicts with the current state", detail: err.message, retry: true };
      case err.status === 429:
        return { title: "Too many requests", detail: "Wait a few seconds, then retry.", retry: true };
      case err.code === "invalid_response":
        return { title: `${capitalize(what)} failed validation`, detail: `${err.message} Nothing was rendered from it.`, retry: true };
      default:
        return { title: `Couldn't load ${what}`, detail: `${err.message} (${err.code})`, retry: true };
    }
  }
  return { title: `Couldn't load ${what}`, detail: err instanceof Error ? err.message : "Unknown error.", retry: true };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The message to show inline under a form after a failed mutation: what failed, then what to do. */
export function inlineError(err: unknown): string {
  if (err instanceof ApiError) return err.fix ? `${err.message} ${err.fix.explanation}` : err.message;
  return describeError(err).detail;
}
