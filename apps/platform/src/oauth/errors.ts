/**
 * Two error shapes, on purpose:
 * - platform JSON endpoints (`/api/v1/oauth/*`, `/api/v1/agent-sessions`) throw `ApiError`, which
 *   becomes `{ error: { code, message, fix } }` (fix texts from @app/conventions where a code exists);
 * - OAuth protocol endpoints (`/api/oauth/token`, `/api/oauth/revoke`, authorize redirects) must
 *   answer in RFC 6749 §5.2 form so stock OAuth clients understand them: `{ error, error_description }`,
 *   plus our `fix` as an extension member (RFC 6749 §8.2 allows additional members).
 */
import { fixFor as conventionFix } from "@app/conventions";
import type { ErrorFix } from "@app/domain";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "../errors.js";

/** An ApiError whose default fix comes from @app/conventions (with links to `<host>/start`). */
export function apiError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
  host: string,
  opts: { details?: unknown; fix?: Partial<ErrorFix> } = {},
): ApiError {
  const base = conventionFix(code, { host });
  return new ApiError(status, code, message, opts.details, { ...base, ...opts.fix });
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "server_error";

/** RFC 6749 §5.2 error from the token/revocation endpoints. */
export class OAuthProtocolError extends Error {
  override readonly name = "OAuthProtocolError";
  constructor(
    readonly error: OAuthErrorCode,
    readonly description: string,
    readonly status: 400 | 401 | 500 = 400,
    readonly fix?: ErrorFix,
  ) {
    super(description);
  }
}

const OAUTH_FIXES: Partial<Record<OAuthErrorCode, string>> = {
  invalid_request:
    "Fix the named parameter and retry. The token endpoint takes application/x-www-form-urlencoded.",
  invalid_client:
    "Use client_id=gittifacts-cli (first-party CLI) or an https URL serving a Client ID Metadata Document.",
  invalid_grant:
    "The code, device code or refresh token is unknown, expired, already used or revoked. Start the authorization again.",
  unsupported_grant_type:
    "Supported: authorization_code (with PKCE S256), refresh_token, urn:ietf:params:oauth:grant-type:device_code.",
  invalid_scope:
    "Request a subset of repo:read plan:create change:create. Agents can never approve plans or changes.",
  invalid_target:
    "Send resource=<origin>/mcp for the MCP server or <origin>/api for the HTTP API (RFC 8707).",
  authorization_pending:
    "The human has not approved the code yet. Keep polling at the given interval.",
  slow_down: "You polled too fast. Add 5 seconds to your polling interval.",
  expired_token: "The device code expired. Request a new one and show the human the new code.",
  access_denied: "The human denied the request. Ask them before trying again.",
};

export function oauthErrorBody(e: OAuthProtocolError, host: string) {
  const explanation = e.fix?.explanation ?? OAUTH_FIXES[e.error] ?? "Read error_description.";
  return {
    error: e.error,
    error_description: e.description,
    fix: { ...e.fix, explanation, docsUrl: `${host}/start` },
  };
}
