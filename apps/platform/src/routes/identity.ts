import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  CreateAgentBody,
  IdempotencyHeaders,
  PrincipalIdParam,
  PrincipalSchema,
  PrincipalWithOwnerSchema,
  RepoSchema,
  SessionUserSchema,
} from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { registerOAuthRoutes } from "../oauth/routes.js";
import { capabilities, REPO_ACTIONS } from "../services/capabilities.js";
import {
  createAgent,
  getPrincipalDetail,
  listPrincipals,
  revokeTokens,
} from "../services/identity.js";
import { type ApiApp, body, errors, json, SECURITY } from "./common.js";

const me = createRoute({
  method: "get",
  path: "/api/v1/me",
  tags: ["identity"],
  summary: "The calling principal (and the signed-in user, for humans)",
  security: SECURITY,
  middleware: [requirePrincipal()] as const,
  responses: {
    200: json(
      z.object({ principal: PrincipalSchema, user: SessionUserSchema.nullable() }),
      "Caller",
    ),
    ...errors(401),
  },
});

const CapabilitiesSchema = z
  .object({
    principal: PrincipalSchema,
    user: SessionUserSchema.nullable(),
    scopes: z.array(PrincipalSchema.shape.scopes.element),
    canApprove: z.boolean().describe("Humans with plan:approve; always false for agents"),
    repos: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        defaultBranch: z.string(),
        claim: RepoSchema.shape.claim,
        template: z.string().nullable(),
        actions: z.array(z.enum(REPO_ACTIONS)),
        aiBudgetUsdPerChange: z.number(),
      }),
    ),
    quotas: z.object({
      enforced: z.boolean(),
      ciMinutesPerDay: z.number().nullable(),
      ciMinutesUsedToday: z.number().nullable(),
      artifactsOpsPerDay: z.number().nullable(),
      storageBytes: z.number().nullable(),
    }),
  })
  .meta({ id: "Capabilities" });

const capabilitiesRoute = createRoute({
  method: "get",
  path: "/api/v1/capabilities",
  tags: ["identity"],
  summary: "Who am I, what may I do, on which repos (with claim status), and my quotas",
  security: SECURITY,
  middleware: [requirePrincipal()] as const,
  responses: { 200: json(CapabilitiesSchema, "Capabilities"), ...errors(401) },
});

const principals = createRoute({
  method: "get",
  path: "/api/v1/principals",
  tags: ["identity"],
  summary: "The caller and the agents it owns",
  security: SECURITY,
  middleware: [requirePrincipal()] as const,
  responses: {
    200: json(z.object({ principals: z.array(PrincipalSchema) }), "Principals"),
    ...errors(401),
  },
});

const principalById = createRoute({
  method: "get",
  path: "/api/v1/principals/{id}",
  tags: ["identity"],
  summary: "A principal by id (agents include their owner's name)",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: PrincipalIdParam },
  responses: {
    200: json(z.object({ principal: PrincipalWithOwnerSchema }), "Principal"),
    ...errors(401, 403, 404),
  },
});

const createAgentRoute = createRoute({
  method: "post",
  path: "/api/v1/principals/agents",
  tags: ["identity"],
  summary: "Register an agent principal owned by the caller; returns its bearer token once",
  description:
    "Humans only. Agents may hold repo:read, plan:create and change:create; never plan:approve, change:review, policy:admin or repo:admin.",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true }), idempotent()] as const,
  request: { headers: IdempotencyHeaders, body: body(CreateAgentBody) },
  responses: {
    201: json(z.object({ principal: PrincipalSchema, token: z.string() }), "Agent created"),
    ...errors(400, 401, 403),
  },
});

const revoke = createRoute({
  method: "delete",
  path: "/api/v1/principals/{id}/tokens",
  tags: ["identity"],
  summary: "Revoke every token of a principal (its owner or itself)",
  security: SECURITY,
  middleware: [requirePrincipal(), idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: PrincipalIdParam },
  responses: {
    200: json(z.object({ revoked: z.number().int() }), "Revoked"),
    ...errors(401, 403, 404),
  },
});

export function registerIdentityRoutes(app: ApiApp): void {
  app.openapi(me, (c) => {
    const caller = callerOf(c);
    return c.json({ principal: caller.principal, user: caller.user }, 200);
  });
  app.openapi(capabilitiesRoute, async (c) =>
    c.json(await capabilities(c.get("services"), callerOf(c)), 200),
  );
  app.openapi(principals, async (c) => {
    return c.json({ principals: await listPrincipals(c.get("services"), callerOf(c)) }, 200);
  });
  app.openapi(principalById, async (c) =>
    c.json(await getPrincipalDetail(c.get("services"), c.req.valid("param").id), 200),
  );
  app.openapi(createAgentRoute, async (c) => {
    const out = await createAgent(c.get("services"), callerOf(c), c.req.valid("json"));
    return c.json(out, 201);
  });
  app.openapi(revoke, async (c) => {
    const revoked = await revokeTokens(c.get("services"), callerOf(c), c.req.valid("param").id);
    return c.json({ revoked }, 200);
  });
  // Delegated agent auth (O4): MCP OAuth, device flow, consent, agent sessions.
  registerOAuthRoutes(app);
}
