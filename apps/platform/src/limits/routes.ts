/**
 * Platform-admin controls for unclaimed projects and the platform's spend:
 *
 *   GET /api/v1/admin/unclaimed-creation   kill-switch state (flag, override, effective)
 *   PUT /api/v1/admin/unclaimed-creation   set the D1 override: "off" | "on" | "flag" (clear)
 *   GET /api/v1/admin/spend                today's metered spend by source, budgets, breaker
 *   PUT /api/v1/admin/spend-breaker        resume paid work for the rest of today, or "auto"
 *
 * Platform admins are humans whose principal id (`hu_…`, see GET /api/v1/me) or user id is listed in
 * `PLATFORM_ADMINS` (comma-separated). Repo scopes don't make anyone a platform admin: every human
 * holds them. With the list unset, nobody can change the override (Flagship remains the switch).
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Caller } from "../app-env.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { forbidden } from "../errors.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { type BreakerState, breakerState, setResume } from "../spend/breaker.js";
import { SPEND_SOURCES } from "../spend/meter.js";
import { unclaimedCreationState, writeOverride } from "./kill-switch.js";

const StateSchema = z
  .object({
    enabled: z.boolean(),
    source: z.enum(["override", "flag", "flag-unavailable", "spend-breaker"]),
    override: z.enum(["on", "off"]).nullable(),
    flag: z.boolean().nullable(),
    detail: z.string().nullable(),
  })
  .meta({ id: "UnclaimedCreationState" });

export function assertPlatformAdmin(caller: Caller, env: { PLATFORM_ADMINS?: string }): void {
  // Principal ids (or better-auth user ids), never e-mails: e-mail sign-up is not verified, so
  // anyone could register an admin's address before they do.
  const admins = (env.PLATFORM_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const ids = [caller.principal.id, caller.user?.id].filter((x): x is string => !!x);
  if (caller.principal.kind !== "human" || !ids.some((id) => admins.includes(id))) {
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

const SpendSchema = z
  .object({
    day: z.string(),
    totalUsd: z.number(),
    bySource: z.record(z.enum(SPEND_SOURCES), z.number()),
    softUsd: z.number(),
    hardUsd: z.number(),
    level: z.enum(["ok", "soft", "hard"]),
    paused: z.boolean(),
    resumedBy: z.string().nullable(),
  })
  .meta({ id: "PlatformSpend" });

const getSpend = createRoute({
  method: "get",
  path: "/api/v1/admin/spend",
  tags: ["internal"],
  summary: "Today's metered platform spend (USD, upper-bound estimate) and the spend breaker",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true })] as const,
  responses: { 200: json(SpendSchema, "Spend"), ...errors(401, 403) },
});

const putBreaker = createRoute({
  method: "put",
  path: "/api/v1/admin/spend-breaker",
  tags: ["internal"],
  summary:
    "Resume paid work after the spend breaker tripped (until 00:00 UTC), or hand back to the budgets",
  description:
    "`resume`: new CI runs, workspaces, previews, QA and model calls start again for the rest of the UTC day, whatever today's spend. `auto`: the daily budgets decide again. Platform admins only (PLATFORM_ADMINS).",
  security: SECURITY,
  middleware: [requirePrincipal([], { humanOnly: true })] as const,
  request: { body: body(z.object({ mode: z.enum(["resume", "auto"]) })) },
  responses: { 200: json(SpendSchema, "New state"), ...errors(400, 401, 403) },
});

const spendView = (s: BreakerState) => ({
  day: s.day,
  totalUsd: Math.round(s.spend.totalUsd * 1e4) / 1e4,
  bySource: s.spend.bySource,
  softUsd: s.softUsd,
  hardUsd: s.hardUsd,
  level: s.level,
  paused: s.paused,
  resumedBy: s.resumedBy,
});

export function registerLimitRoutes(app: ApiApp): void {
  app.openapi(getSpend, async (c) => {
    assertPlatformAdmin(callerOf(c), c.env);
    const now = c.get("services").clock.now().getTime();
    return c.json(spendView(await breakerState(c.env, now)), 200);
  });

  app.openapi(putBreaker, async (c) => {
    const caller = callerOf(c);
    assertPlatformAdmin(caller, c.env);
    const svc = c.get("services");
    const { mode } = c.req.valid("json");
    const now = svc.clock.now().getTime();
    await setResume(c.env, mode === "resume", caller.principal.id, now);
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "platform.spend-breaker",
      subject: "platform:spend",
      payload: { mode },
    });
    return c.json(spendView(await breakerState(c.env, now)), 200);
  });

  app.openapi(get, async (c) => {
    assertPlatformAdmin(callerOf(c), c.env);
    const svc = c.get("services");
    return c.json(await unclaimedCreationState(svc.store, c.env.FLAGS, c.env), 200);
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
    return c.json(await unclaimedCreationState(svc.store, c.env.FLAGS, c.env), 200);
  });
}
