/**
 * Platform-admin controls for unclaimed projects:
 *
 *   GET /api/v1/admin/unclaimed-creation   kill-switch state (flag, override, effective)
 *   PUT /api/v1/admin/unclaimed-creation   set the D1 override: "off" | "on" | "flag" (clear)
 *
 * Platform admins are humans whose e-mail is listed in `PLATFORM_ADMINS` (comma-separated). Repo
 * scopes don't make anyone a platform admin: every human holds them on their own repos. With the
 * list unset, nobody can change the override (Flagship remains the switch).
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Caller } from "../app-env.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { forbidden } from "../errors.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { unclaimedCreationState, writeOverride } from "./kill-switch.js";

const StateSchema = z
  .object({
    enabled: z.boolean(),
    source: z.enum(["override", "flag", "flag-unavailable"]),
    override: z.enum(["on", "off"]).nullable(),
    flag: z.boolean().nullable(),
    detail: z.string().nullable(),
  })
  .meta({ id: "UnclaimedCreationState" });

export function assertPlatformAdmin(caller: Caller, env: { PLATFORM_ADMINS?: string }): void {
  const admins = (env.PLATFORM_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const email = caller.user?.email.toLowerCase() ?? null;
  if (caller.principal.kind !== "human" || email === null || !admins.includes(email)) {
    throw forbidden("only a platform admin may do this", undefined, {
      explanation:
        admins.length === 0
          ? "No platform admins are configured (PLATFORM_ADMINS). Use the Flagship flag unclaimed-creation-enabled instead."
          : "Ask a platform admin (PLATFORM_ADMINS) to change it, or use the Flagship flag unclaimed-creation-enabled.",
    });
  }
}

const get = createRoute({
  method: "get",
  path: "/api/v1/admin/unclaimed-creation",
  tags: ["internal"],
  summary: "Kill switch for credential-less project creation: flag, override, effective state",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true })] as const,
  responses: { 200: json(StateSchema, "State"), ...errors(401, 403) },
});

const put = createRoute({
  method: "put",
  path: "/api/v1/admin/unclaimed-creation",
  tags: ["internal"],
  summary: "Override the kill switch in D1 (works when Flagship is unreachable)",
  description:
    "`off` stops unclaimed creation at once, whatever the flag says. `on` only bridges a Flagship that cannot be evaluated (a flag set to false still wins). `flag` clears the override. Platform admins only (PLATFORM_ADMINS).",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true })] as const,
  request: { body: body(z.object({ mode: z.enum(["off", "on", "flag"]) })) },
  responses: { 200: json(StateSchema, "New state"), ...errors(400, 401, 403) },
});

export function registerLimitRoutes(app: ApiApp): void {
  app.openapi(get, async (c) => {
    assertPlatformAdmin(callerOf(c), c.env);
    const svc = c.get("services");
    return c.json(await unclaimedCreationState(svc.store, c.env.FLAGS), 200);
  });

  app.openapi(put, async (c) => {
    const caller = callerOf(c);
    assertPlatformAdmin(caller, c.env);
    const svc = c.get("services");
    const { mode } = c.req.valid("json");
    await writeOverride(
      svc.store,
      mode === "flag" ? null : mode,
      caller.principal.id,
      svc.clock.now(),
    );
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "platform.unclaimed-creation-override",
      subject: "platform:unclaimed-creation",
      payload: { mode },
    });
    return c.json(await unclaimedCreationState(svc.store, c.env.FLAGS), 200);
  });
}
