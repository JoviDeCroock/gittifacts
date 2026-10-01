/**
 * POST /mcp — stateless streamable HTTP MCP (SDK v2 `createMcpHandler`, a fresh server per
 * request), behind an Origin check and the agent bearer gate (stack.md §4).
 */
import { createMcpServer } from "@app/mcp";
import {
  type AuthInfo,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { verifyAgentToken } from "../auth/agent-tokens.js";
import { authBaseUrl } from "../auth/better-auth.js";
import { createPlatformMcpBackend } from "./backend.js";

export const MCP_PATH = "/mcp";

export async function handleMcp(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  // Browsers may only call from our own origin (DNS-rebinding / CSRF); no Origin (agents) is fine.
  const allowed = [...new Set([new URL(authBaseUrl(c.env, url.origin)).hostname, url.hostname])];
  const badOrigin = originValidationResponse(c.req.raw, allowed);
  if (badOrigin) return badOrigin;

  const svc = c.get("services");
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const v = await verifyAgentToken(svc.store, token, svc.clock.now(), svc.waitUntil);
        if (!v)
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            "invalid, expired or revoked agent token",
          );
        return {
          token,
          clientId: v.principal.id,
          scopes: [...v.principal.scopes],
          // The SDK gate rejects AuthInfo without expiresAt, even for long-lived tokens.
          expiresAt: v.expiresAtSec,
          extra: { principal: v.principal },
        };
      },
    },
  });
  const authInfo = await gate(c.req.raw);
  if (authInfo instanceof Response) return authInfo;

  const backend = createPlatformMcpBackend(svc);
  const handler = createMcpHandler(() => createMcpServer(backend));
  return handler.fetch(c.req.raw, { authInfo });
}
