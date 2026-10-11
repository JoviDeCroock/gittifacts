import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  AuditEventSchema,
  AuditQuery,
  ChainStatusSchema,
  PrincipalsMapSchema,
} from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { listAudit } from "../services/audit.js";
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
      }),
      "Audit page",
    ),
    ...errors(400, 401, 403, 404),
  },
});

export function registerAuditRoutes(app: ApiApp): void {
  app.openapi(list, async (c) =>
    c.json(await listAudit(c.get("services"), callerOf(c), c.req.valid("query")), 200),
  );
}
