/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) client.
 *
 * Endpoints, in order of precedence:
 * 1. `--device-code-url` / `--token-url` (or GITTIFACTS_DEVICE_CODE_URL / GITTIFACTS_DEVICE_TOKEN_URL)
 * 2. `GET <host>/start` (JSON) → `auth.deviceFlow.{deviceAuthorizationEndpoint, tokenEndpoint, clientId}`
 * 3. `GET <host>/.well-known/oauth-authorization-server` (RFC 8414) → `device_authorization_endpoint`
 *    and the `token_endpoint` (RFC 8628 §4: device codes are redeemed at the AS's token endpoint)
 * 4. The platform's paths: `/api/auth/device/code` (better-auth's device-authorization plugin) and
 *    `/api/oauth/token` (apps/platform `OAUTH_PATHS`; it issues an agent token, never a session)
 *
 * Polling follows RFC 8628 §3.5: wait `interval` between requests; `authorization_pending` keeps
 * going, `slow_down` adds 5s for this and every later request, `expired_token` and
 * `access_denied` stop. Connection failures back off exponentially.
 */
import { cliError, EXIT } from "../errors.js";
import type { FetchLike } from "../mcp.js";
import { isRecord } from "../tools/schema.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const DEFAULT_CLIENT_ID = "gittifacts-cli";
export const DEFAULT_DEVICE_CODE_PATH = "/api/auth/device/code";
export const DEFAULT_DEVICE_TOKEN_PATH = "/api/oauth/token";
/** RFC 8628 §3.2: "If no value is provided, clients MUST use 5 as the default." */
export const DEFAULT_INTERVAL_SEC = 5;
export const SLOW_DOWN_STEP_SEC = 5;
const MAX_BACKOFF_SEC = 60;
const MAX_CONSECUTIVE_FAILURES = 5;
const DISCOVERY_TIMEOUT_MS = 5000;

export interface DeviceEndpoints {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  source: "override" | "start" | "metadata" | "default";
}

export interface EndpointOverrides {
  deviceCodeUrl?: string | undefined;
  tokenUrl?: string | undefined;
  clientId?: string | undefined;
}

async function getJson(fetch: FetchLike, url: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

const strField = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (typeof o[k] === "string" && o[k] !== "") return o[k];
  return undefined;
};

export async function discoverEndpoints(
  fetch: FetchLike,
  host: string,
  overrides: EndpointOverrides = {},
): Promise<DeviceEndpoints> {
  const abs = (u: string) => new URL(u, host).toString();
  let device = overrides.deviceCodeUrl;
  let token = overrides.tokenUrl;
  let clientId = overrides.clientId;
  let source: DeviceEndpoints["source"] = "override";

  if (!device || !token) {
    const start = await getJson(fetch, `${host}/start`);
    const flow = isRecord(start) && isRecord(start.auth) && isRecord(start.auth.deviceFlow) ? start.auth.deviceFlow : null;
    if (flow) {
      const d = strField(flow, "deviceAuthorizationEndpoint", "device_authorization_endpoint");
      const t = strField(flow, "tokenEndpoint", "token_endpoint");
      clientId ??= strField(flow, "clientId", "client_id");
      if (d && !device) {
        device = d;
        source = "start";
      }
      if (t && !token) token = t;
    }
  }
  if (!device || !token) {
    const meta = await getJson(fetch, `${host}/.well-known/oauth-authorization-server`);
    if (isRecord(meta)) {
      const d = strField(meta, "device_authorization_endpoint");
      const grants = Array.isArray(meta.grant_types_supported) ? meta.grant_types_supported : [];
      // An AS that advertises a device endpoint redeems its codes at its token endpoint.
      const t = d || grants.includes(DEVICE_GRANT) ? strField(meta, "token_endpoint") : undefined;
      if (d && !device) {
        device = d;
        source = "metadata";
      }
      if (t && !token) token = t;
    }
  }
  if (!device) source = "default";
  return {
    deviceAuthorizationUrl: abs(device ?? DEFAULT_DEVICE_CODE_PATH),
    tokenUrl: abs(token ?? DEFAULT_DEVICE_TOKEN_PATH),
    clientId: clientId ?? DEFAULT_CLIENT_ID,
    source,
  };
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

function form(fields: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The OAuth error code of a response body: `error` (RFC 6749 §5.2), else better-auth's `code`. */
export function oauthErrorOf(body: unknown): { error: string; description?: string } | null {
  if (!isRecord(body)) return null;
  const description = typeof body.error_description === "string" ? body.error_description : typeof body.message === "string" ? body.message : undefined;
  if (typeof body.error === "string") return { error: body.error, ...(description ? { description } : {}) };
  if (typeof body.code === "string") return { error: body.code.toLowerCase(), ...(description ? { description } : {}) };
  return null;
}

function unavailable(host: string, url: string, status: number) {
  return cliError("device-flow-unavailable", `${host} does not offer the OAuth device flow at ${url} (HTTP ${status})`, {
    explanation:
      "Use an agent token a human created for you (export GITTIFACTS_TOKEN=...), or create an unclaimed project without an account with `gittifacts init`. If the platform documents other endpoints, pass --device-code-url and --token-url.",
    command: `curl -sS -H 'accept: application/json' ${host}/start`,
  });
}

export async function requestDeviceCode(
  fetch: FetchLike,
  host: string,
  endpoints: DeviceEndpoints,
  scope?: string,
): Promise<DeviceAuthorization> {
  let res: Response;
  try {
    res = await fetch(endpoints.deviceAuthorizationUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form({ client_id: endpoints.clientId, scope }),
    });
  } catch (e) {
    throw cliError("network", `could not reach ${endpoints.deviceAuthorizationUrl}`, {
      explanation: `Check the host (${host}) and your connection, then run login again.`,
      command: `gittifacts login --host ${host}`,
    }, { details: e instanceof Error ? e.message : String(e) });
  }
  const body = await readBody(res);
  if (res.status === 404 || res.status === 405) throw unavailable(host, endpoints.deviceAuthorizationUrl, res.status);
  if (!res.ok) {
    const err = oauthErrorOf(body);
    throw cliError("device-flow-failed", `device authorization failed: ${err?.error ?? `HTTP ${res.status}`}${err?.description ? ` (${err.description})` : ""}`, {
      explanation: err?.error === "invalid_client"
        ? "The platform doesn't know this client id. Pass the one it documents with --client-id."
        : "The platform refused to start a device login. Retry; if it persists, use an agent token (GITTIFACTS_TOKEN).",
      command: `gittifacts login --host ${host}`,
    }, { details: body });
  }
  if (
    !isRecord(body) ||
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw cliError("invalid-response", "the device authorization response is missing device_code, user_code or verification_uri", {
      explanation: "The endpoint isn't an RFC 8628 device authorization endpoint. Pass the right one with --device-code-url.",
      command: `curl -sS -H 'accept: application/json' ${host}/start`,
    }, { details: body });
  }
  const abs = (u: string) => new URL(u, host).toString();
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: abs(body.verification_uri),
    verificationUriComplete:
      typeof body.verification_uri_complete === "string" ? abs(body.verification_uri_complete) : null,
    expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 1800,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : DEFAULT_INTERVAL_SEC,
  };
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number | null;
  scope: string | null;
}

export type PollEvent =
  | { type: "pending"; intervalSec: number }
  | { type: "slow_down"; intervalSec: number }
  | { type: "retry"; intervalSec: number; reason: string };

export interface PollOptions {
  fetch: FetchLike;
  host: string;
  tokenUrl: string;
  clientId: string;
  deviceCode: string;
  intervalSec: number;
  expiresInSec: number;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal | undefined;
  onEvent?(e: PollEvent): void;
}

/** Polls the token endpoint until approval, denial or expiry (RFC 8628 §3.4–3.5). */
export async function pollForToken(o: PollOptions): Promise<TokenResponse> {
  /** RFC 8628 interval, raised by `slow_down`. */
  let interval = Math.max(1, o.intervalSec);
  const deadline = o.now() + o.expiresInSec * 1000;
  let failures = 0;
  const loginAgain = `gittifacts login --host ${o.host}`;
  const expired = () =>
    cliError("device-code-expired", "the login code expired before it was approved", {
      explanation: "Run login again and approve the new code in the browser before it expires.",
      command: loginAgain,
    });
  const transient = (reason: string) => {
    failures += 1;
    if (failures > MAX_CONSECUTIVE_FAILURES) {
      throw cliError("network", `the token endpoint kept failing: ${reason}`, {
        explanation: `Check the host (${o.host}) and your connection, then finish the same login with --device-code.`,
        command: `${loginAgain} --device-code ${o.deviceCode}`,
      });
    }
    o.onEvent?.({ type: "retry", intervalSec: wait(), reason });
  };
  // Connection trouble backs off exponentially on top of the interval; one good answer resets it.
  const wait = () => (failures === 0 ? interval : Math.min(interval * 2 ** failures, MAX_BACKOFF_SEC));

  for (;;) {
    await o.sleep(wait() * 1000, o.signal);
    // Don't spend a request on a code that has already expired.
    if (o.now() >= deadline) throw expired();
    let res: Response;
    try {
      res = await o.fetch(o.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form({ grant_type: DEVICE_GRANT, device_code: o.deviceCode, client_id: o.clientId }),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      transient(e instanceof Error ? e.message : String(e));
      continue;
    }
    const body = await readBody(res);
    if (res.ok && isRecord(body) && typeof body.access_token === "string") {
      return {
        accessToken: body.access_token,
        tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
        expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
        scope: typeof body.scope === "string" && body.scope !== "" ? body.scope : null,
      };
    }
    const err = oauthErrorOf(body);
    switch (err?.error) {
      case "authorization_pending":
        failures = 0;
        o.onEvent?.({ type: "pending", intervalSec: interval });
        continue;
      case "slow_down":
        failures = 0;
        interval += SLOW_DOWN_STEP_SEC;
        o.onEvent?.({ type: "slow_down", intervalSec: interval });
        continue;
      case "expired_token":
        throw expired();
      case "access_denied":
        throw cliError("access-denied", "the login was denied in the browser", {
          explanation:
            "Someone declined this device login. If that was a mistake, run login again; otherwise use an agent token (GITTIFACTS_TOKEN).",
          command: loginAgain,
        });
      default:
        if (res.status === 404 || res.status === 405) throw unavailable(o.host, o.tokenUrl, res.status);
        if (res.status >= 500 || res.status === 429) {
          transient(`HTTP ${res.status}`);
          continue;
        }
        throw cliError(
          "device-flow-failed",
          `login failed: ${err?.error ?? `HTTP ${res.status}`}${err?.description ? ` (${err.description})` : ""}`,
          { explanation: "The platform rejected the device code. Run login again.", command: loginAgain },
          { details: body, exitCode: EXIT.error },
        );
    }
  }
}
