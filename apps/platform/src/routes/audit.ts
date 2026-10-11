import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  AuditEventSchema,
  AuditQuery,
  AuditSubjectsMapSchema,
  ChainStatusSchema,
  PrincipalsMapSchema,
} from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { assertPlatformAdmin } from "../limits/routes.js";
import { listAudit, reverifyAudit } from "../services/audit.js";
import { type ApiApp, errors, json, SECURITY } from "./common.js";

const list = createRoute({
  method: "get",
  path: "/api/v1/audit",
  tags: ["audit"],
  summary: "Audit log, newest first, with hash-chain verification",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { query: AuditQuery },
  responses: {
    200: json(
      z.object({
        events: z.array(AuditEventSchema),
        nextCursor: z.string().nullable(),
        chain: ChainStatusSchema,
        principals: PrincipalsMapSchema,
        subjects: AuditSubjectsMapSchema,
      }),
      "Audit page",
    ),
    ...errors(400, 401, 403, 404),
  },
});

const reverify = createRoute({
  method: "post",
  path: "/api/v1/admin/audit/verify",
  tags: ["internal"],
  summary: "Re-verify the whole audit chain from genesis, ignoring the verified-through checkpoint",
  description:
    "Reads verify the chain incrementally from a checkpoint. This checks every entry again (O(N) signature checks), clears a recorded break when the chain passes, and moves the checkpoint to the head. Platform admins only (PLATFORM_ADMINS).",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true })] as const,
  responses: {
    200: json(ChainStatusSchema.extend({ checked: z.number().int() }), "Full verification"),
    ...errors(401, 403),
  },
});

export function registerAuditRoutes(app: ApiApp): void {
  app.openapi(reverify, async (c) => {
    assertPlatformAdmin(callerOf(c), c.env);
    return c.json(await reverifyAudit(c.get("services")), 200);
  });

  app.openapi(list, async (c) =>
    c.json(await listAudit(c.get("services"), callerOf(c), c.req.valid("query")), 200),
  );
}
