/**
 * RFC 8628 device flow on better-auth's `device-authorization` plugin, with one hard change:
 * a device code NEVER becomes a better-auth (human) session.
 *
 * The plugin's own `/device/token` mints a session for the approving user. A CLI holding that
 * token would act as the human, scopes and all (plan:approve included). So:
 * - the `grant` below refuses session redemption for every code (`assertSessionRedemption`), and
 * - `/device/token`, `/device/approve`, `/device/deny` and `/device` are in `disabledPaths`.
 * Codes are redeemed only through the server-only `redeemAgentDeviceCode` endpoint (the plugin's
 * `redeemDeviceCode` state machine: expiry, slow_down, denial, one-time atomic claim) from our
 * token endpoint, which issues an agent token bound to a new agent principal. Approval happens only
 * through `/api/v1/oauth/device/{userCode}/approve`, which records the human's scopes and repos first.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { type DeviceAuthorizationGrant, redeemDeviceCode } from "better-auth/plugins";
import { z } from "zod";
import { resolveClient } from "./clients.js";
import { parseRequestedScopes } from "./scopes.js";
import { oauthUrls, resolveAudience } from "./urls.js";

/** better-auth routes that must never be reachable over HTTP (they would bypass our consent or mint sessions). */
export const DEVICE_DISABLED_PATHS = [
  "/device/token",
  "/device/approve",
  "/device/deny",
  "/device",
] as const;

export const DEVICE_CODE_TTL = "15m";
export const DEVICE_POLL_INTERVAL = "5s";

const requestSchemaFields = {
  resource: z.string().max(2048).optional(),
};

type DeviceGrantFields = { clientName?: string | null; audience?: string | null };

export interface DeviceVerificationContext extends Record<string, unknown> {
  client_name: string | null;
  audience: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export const agentDeviceGrant: DeviceAuthorizationGrant<
  typeof requestSchemaFields,
  DeviceVerificationContext
> = {
  requestSchemaFields,
  requestErrorCodes: ["invalid_target"],
  deviceCodeSchemaFields: {
    clientName: { type: "string", required: false },
    audience: { type: "string", required: false },
  },
  async authorizeRequest({ ctx, request }) {
    if (request.user_id) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_request",
        error_description:
          "user_id is not accepted: the human who enters the code owns the session",
      });
    }
    const client = await resolveClient(request.client_id);
    if (!client.ok) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client",
        error_description: client.message,
      });
    }
    const scopes = parseRequestedScopes(request.scope);
    if (!scopes.ok) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_scope",
        error_description: scopes.description,
      });
    }
    const urls = oauthUrls(new URL(ctx.context.baseURL).origin);
    const aud = resolveAudience(urls, request.resource ? [request.resource] : [], "device_code");
    if (!aud.ok) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_target",
        error_description: aud.description,
      });
    }
    return {
      clientId: client.client.clientId,
      deviceCodeFields: {
        clientName: client.client.name,
        audience: JSON.stringify(aud.audience),
      },
    };
  },
  assertSessionRedemption() {
    throw new APIError("BAD_REQUEST", {
      error: "unsupported_grant_type",
      error_description:
        "device codes are exchanged at /api/oauth/token for an agent token, never for a user session",
    });
  },
  getVerificationContext(row) {
    return { client_name: str(row.clientName), audience: str(row.audience) };
  },
};

export interface RedeemedDeviceCode {
  deviceCodeId: string;
  userId: string;
  clientId: string;
  scope: string | null;
  audience: string | null;
}

/** Server-only endpoint: the plugin's redemption state machine, without minting a session. */
export const agentDeviceRedemption = () =>
  ({
    id: "gittifacts-agent-device",
    endpoints: {
      redeemAgentDeviceCode: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({
            deviceCode: z.string().min(1).max(512),
            clientId: z.string().min(1).max(2048),
          }),
        },
        async (ctx) => {
          const { claimedDeviceCode, user } = await redeemDeviceCode<
            DeviceGrantFields,
            undefined,
            undefined
          >({
            ctx,
            deviceCode: ctx.body.deviceCode,
            authorizeRedemption: (row) => {
              if (row.clientId !== ctx.body.clientId) {
                throw new APIError("BAD_REQUEST", {
                  error: "invalid_grant",
                  error_description: "client_id does not match the device code",
                });
              }
              return {
                ownershipWhere: { field: "clientId", value: ctx.body.clientId },
                context: undefined,
              };
            },
            prepareRedemption: () => undefined,
          });
          const out: RedeemedDeviceCode = {
            deviceCodeId: claimedDeviceCode.id,
            userId: user.id,
            clientId: claimedDeviceCode.clientId ?? ctx.body.clientId,
            scope: claimedDeviceCode.scope ?? null,
            audience: str(claimedDeviceCode.audience),
          };
          return ctx.json(out);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
