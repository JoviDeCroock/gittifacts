/**
 * Claim API (onboarding §4), used by the web page `/claim/<token>`:
 *
 *   GET  /api/v1/claims/{token}   what the project is, who made it, when it expires (no auth;
 *                                 a session, if any, fills `viewer`)
 *   POST /api/v1/claims/{token}   a signed-in human + a Turnstile token claims it
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders } from "../api/schemas.js";
import { resolveCaller } from "../auth/middleware.js";
import { ApiError } from "../errors.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { claimProject, getClaimView } from "./service.js";

const TokenParam = z.object({ token: z.string().min(1).max(200) });

const ClaimViewSchema = z
  .object({
    status: z.enum(["unclaimed", "claimed", "expired"]),
    project: z.object({
      id: z.string(),
      name: z.string(),
      template: z.string().nullable(),
      createdAt: z.string(),
      expiresAt: z.string().nullable(),
      previewUrl: z.string().nullable(),
    }),
    createdBy: z.object({ kind: z.literal("agent"), principalId: z.string(), name: z.string() }),
    claimedBy: z.object({ principalId: z.string(), name: z.string() }).nullable(),
    claimedAt: z.string().nullable(),
    claiming: z.array(z.string()),
    limits: z.array(z.string()),
    turnstile: z.object({ siteKey: z.string() }),
    viewer: z.object({
      signedIn: z.boolean(),
      principalId: z.string().nullable(),
      isClaimer: z.boolean(),
    }),
  })
  .meta({ id: "ClaimView" });

const ClaimResultSchema = z
  .object({
    status: z.literal("claimed"),
    project: z.object({ id: z.string(), name: z.string() }),
    ownerId: z.string(),
    claimedAt: z.string(),
    alreadyClaimed: z.boolean(),
    next: z.object({ repoPath: z.string() }),
  })
  .meta({ id: "ClaimResult" });

const view = createRoute({
  method: "get",
  path: "/api/v1/claims/{token}",
  tags: ["claims"],
  summary: "An unclaimed project behind a claim link: name, creator, expiry, what claiming does",
  request: { params: TokenParam },
  responses: { 200: json(ClaimViewSchema, "The claim"), ...errors(404) },
});

const claim = createRoute({
  method: "post",
  path: "/api/v1/claims/{token}",
  tags: ["claims"],
  summary: "Claim an unclaimed project (signed-in human + Turnstile); single-use, idempotent",
  description:
    "The human becomes the owner, the project stops expiring and its unclaimed limits are lifted; the agent that created it is now owned by the human (same scopes). Retrying as the same human returns `alreadyClaimed: true`; anyone else gets 409. 403 `turnstile-failed` when the check did not pass, 410 when the project expired.",
  security: SECURITY,
  request: {
    params: TokenParam,
    headers: IdempotencyHeaders,
    body: body(z.object({ turnstileToken: z.string().min(1).max(2048) })),
  },
  responses: { 200: json(ClaimResultSchema, "Claimed"), ...errors(400, 401, 403, 404, 409) },
});

export function registerClaimRoutes(app: ApiApp): void {
  app.openapi(view, async (c) => {
    const caller = await resolveCaller(c).catch(() => null);
    const out = await getClaimView(
      c.get("services"),
      c.req.valid("param").token,
      caller?.principal ?? null,
    );
    return c.json(out, 200, { "cache-control": "no-store" });
  });

  app.openapi(claim, async (c) => {
    const caller = await resolveCaller(c);
    if (!caller) {
      const token = c.req.valid("param").token;
      throw new ApiError(401, "unauthorized", "sign in to claim this project", undefined, {
        explanation: `Sign in as a human first, then claim: ${c.get("services").origin}/signin?next=/claim/${encodeURIComponent(token)}`,
      });
    }
    const key = c.req.valid("header")["idempotency-key"];
    const out = await claimProject(
      c.get("services"),
      caller.principal,
      c.req.valid("param").token,
      {
        turnstileToken: c.req.valid("json").turnstileToken,
        remoteIp: c.req.header("cf-connecting-ip") ?? null,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      },
    );
    return c.json(out, 200);
  });
}
