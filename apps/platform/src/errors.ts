/**
 * One error envelope for every API response and MCP tool error (onboarding §5):
 *
 *   { error: { code, message, fix: { explanation, call?, command?, docsUrl? }, details? } }
 *
 * `ERROR_FIXES` is the catalogue: every code has a default fix. Call sites can pass a more
 * specific fix (e.g. the exact `create_plan({...})` call for a missing plan).
 */
import { CoordinatorError } from "@app/coordinator";
import type { ApiError as ApiErrorBody, ErrorFix } from "@app/domain";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { SigningKeyConfigError } from "./signing.js";
import { NotFoundInStore } from "./store/d1-store.js";
import { StoreDataError } from "./store/rows.js";

export type ErrorBody = ApiErrorBody;

/** Default fix per error code. */
export const ERROR_FIXES: Record<string, ErrorFix> = {
  "invalid-request": {
    explanation:
      "The request failed validation. `details` lists each field and what is wrong; fix them and resend.",
  },
  "invalid-input": {
    explanation:
      "The input was rejected by the platform. Read `message`, correct the field, and resend.",
  },
  unauthorized: {
    explanation:
      "Authenticate first. Agents send `Authorization: Bearer gtf_…` (a human creates one with POST /api/v1/principals/agents); humans sign in via /api/auth/sign-in/email or GitHub.",
    command: 'curl -H "Authorization: Bearer $GITTIFACTS_TOKEN" <host>/api/v1/capabilities',
  },
  "insufficient-scope": {
    explanation:
      "Your principal lacks a scope this call needs (see `details.missing`). Agents can only ever hold repo:read, plan:create and change:create; ask the human who owns the agent for the scope, or hand the step to a human.",
    call: "whoami({})",
  },
  forbidden: {
    explanation:
      "Only a human may do this. Agents never approve plans or review changes; ask a human to look at it.",
    call: 'request_review({ changeId: "<changeId>" })',
  },
  "self-approval": {
    explanation:
      "No principal approves its own plan or change. A different human must approve it; ask for a review instead.",
    call: 'request_review({ changeId: "<changeId>" })',
  },
  "scope-not-allowed": {
    explanation:
      "Agents may hold only repo:read, plan:create and change:create, and a human can only delegate scopes they hold. Request a subset.",
  },
  "not-found": {
    explanation:
      "Nothing with that id exists (or it is not ready yet). List what exists and use one of those ids.",
    call: "list_repos({})",
  },
  conflict: {
    explanation:
      "The request conflicts with the current state. Read the resource again and act on its current state.",
  },
  "invalid-state": {
    explanation:
      "The resource's current status does not allow this. Read it again (e.g. get_change_status) and act on its current status.",
    call: 'get_change_status({ changeId: "<changeId>" })',
  },
  "threshold-not-met": {
    explanation:
      "Lane 0 (auto-merge) unlocks only after enough human reviews agree with the classifier's Lane-0 calls. See `shadow.needed` on GET /api/v1/repos/{repoId} and keep reviewing.",
  },
  upstream: {
    explanation:
      "A platform dependency failed or is not available yet. Retry in a few seconds with the same Idempotency-Key; the retry is safe.",
  },
  "idempotency-key-reuse": {
    explanation:
      "This Idempotency-Key was already used for a different request. Use a fresh key for a new request; reuse a key only to retry the exact same request.",
  },
  "idempotency-key-in-flight": {
    explanation:
      "The first request with this Idempotency-Key is still running. Retry the same request in a second.",
  },
  "payload-too-large": { explanation: "The body is too large. Send less data." },
  "http-error": {
    explanation:
      "The HTTP request was not acceptable. Check the method, path and Content-Type: application/json.",
  },
  internal: {
    explanation:
      "Unexpected platform error. Retrying with the same Idempotency-Key is safe; if it keeps failing, report the x-gittifacts-version header value.",
  },
};

const GENERIC_FIX: ErrorFix = { explanation: "Read `message` for what went wrong." };

export function fixFor(code: string, override?: Partial<ErrorFix>): ErrorFix {
  const base = ERROR_FIXES[code] ?? GENERIC_FIX;
  if (!override) return base;
  // An override replaces the whole hint (a generic `call` must not leak into a specific one).
  return { explanation: override.explanation ?? base.explanation, ...withoutUndefined(override) };
}

function withoutUndefined(f: Partial<ErrorFix>): Partial<ErrorFix> {
  const out: Partial<ErrorFix> = {};
  if (f.explanation !== undefined) out.explanation = f.explanation;
  if (f.call !== undefined) out.call = f.call;
  if (f.command !== undefined) out.command = f.command;
  if (f.docsUrl !== undefined) out.docsUrl = f.docsUrl;
  return out;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly fix: ErrorFix;
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    fix?: Partial<ErrorFix>,
  ) {
    super(message);
    this.fix = fixFor(code, fix);
  }
}

export const unauthorized = (message = "authentication required") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message: string, details?: unknown, fix?: Partial<ErrorFix>) =>
  new ApiError(403, "forbidden", message, details, fix);
export const notFound = (what: string, fix?: Partial<ErrorFix>) =>
  new ApiError(404, "not-found", `${what} not found`, undefined, fix);
export const conflict = (message: string, code = "conflict", fix?: Partial<ErrorFix>) =>
  new ApiError(409, code, message, undefined, fix);
export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "invalid-request", message, details);

/** CoordinatorError code → HTTP status (extra keys tolerated while the contract evolves). */
export const COORDINATOR_STATUS: { [K in CoordinatorError["code"]]: ContentfulStatusCode } & Record<
  string,
  ContentfulStatusCode
> = {
  "invalid-input": 400,
  "not-found": 404,
  forbidden: 403,
  "self-approval": 403,
  conflict: 409,
  "invalid-state": 409,
  "threshold-not-met": 409,
  upstream: 502,
};

function isCoordinatorError(err: unknown): err is CoordinatorError {
  if (err instanceof CoordinatorError) return true;
  if (!(err instanceof Error) || err.name !== "CoordinatorError") return false;
  const code: unknown = (err as Error & { code?: unknown }).code;
  return typeof code === "string" && code in COORDINATOR_STATUS;
}

/** The coordinator's own fix hint wins over the catalogue default. */
function coordinatorFix(err: CoordinatorError): Partial<ErrorFix> | undefined {
  const fix: unknown = err.fix;
  if (
    fix &&
    typeof fix === "object" &&
    typeof (fix as { explanation?: unknown }).explanation === "string"
  ) {
    return fix as Partial<ErrorFix>;
  }
  return undefined;
}

export function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

function envelope(code: string, message: string, fix: ErrorFix, details?: unknown): ErrorBody {
  return { error: { code, message, fix, ...(details !== undefined ? { details } : {}) } };
}

/** Map any thrown value to a status + envelope. Unknown errors are logged and hidden. */
export function toErrorResponse(err: unknown): { status: ContentfulStatusCode; body: ErrorBody } {
  if (err instanceof ApiError) {
    return { status: err.status, body: envelope(err.code, err.message, err.fix, err.details) };
  }
  if (isCoordinatorError(err)) {
    const status = COORDINATOR_STATUS[err.code] ?? 500;
    return { status, body: envelope(err.code, err.message, fixFor(err.code, coordinatorFix(err))) };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: envelope(
        "invalid-request",
        "request failed validation",
        fixFor("invalid-request"),
        zodIssues(err),
      ),
    };
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const code = status === 400 ? "invalid-request" : "http-error";
    return { status, body: envelope(code, err.message, fixFor(code)) };
  }
  if (err instanceof NotFoundInStore) {
    return { status: 404, body: envelope("not-found", err.message, fixFor("not-found")) };
  }
  if (err instanceof StoreDataError || err instanceof SigningKeyConfigError) {
    console.error(err);
    return { status: 500, body: envelope("internal", err.message, fixFor("internal")) };
  }
  console.error("unhandled error", err);
  return { status: 500, body: envelope("internal", "internal error", fixFor("internal")) };
}
