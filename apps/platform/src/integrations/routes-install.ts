/**
 * Install screen, installed integrations (humans) and the integration's own view of itself.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { urlsFor } from "../oauth/context.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import { approveInstall, denyInstall, getInstallRequest, InstallViewSchema } from "./consent.js";
import { InstallDecisionBody } from "./install.js";
import {
  CurrentInstallationSchema,
  currentInstallation,
  InstallationViewSchema,
  listInstallations,
  uninstallInstallation,
  updateInstallationRepos,
} from "./installed.js";

const TAG = ["integrations"];
const humanOnly = requirePrincipal([], { humanOnly: true });
const RequestParam = z.object({ id: z.string().min(16).max(128) });
const InstallationParam = z.object({ installationId: z.string().min(1).max(64) });
const Redirect = z.object({ redirectTo: z.string() });

const getRequest = createRoute({
  method: "get",
  path: "/api/v1/integration-installs/{id}",
  tags: TAG,
  security: SECURITY,
  summary: "What an integration asks for, in plain words, and the repos you may install it on",
  description:
    "Humans only. The first signed-in human to open an install request owns its decision.",
  middleware: [humanOnly] as const,
  request: { params: RequestParam },
  responses: {
    200: json(z.object({ install: InstallViewSchema }), "Install request"),
    ...errors(401, 403, 404),
  },
});
const approve = createRoute({
  method: "post",
  path: "/api/v1/integration-installs/{id}/approve",
  tags: TAG,
  security: SECURITY,
  summary:
    "Install (or update) the integration on all or selected repos; returns where to send the browser",
  description:
    "Only claimed repos you own can be selected; unclaimed projects are refused (repo-not-installable).",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RequestParam, body: body(InstallDecisionBody) },
  responses: { 200: json(Redirect, "Installed"), ...errors(400, 401, 403, 404, 409) },
});
const deny = createRoute({
  method: "post",
  path: "/api/v1/integration-installs/{id}/deny",
  tags: TAG,
  security: SECURITY,
  summary: "Decline an install request; returns where to send the browser",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: RequestParam },
  responses: { 200: json(Redirect, "Declined"), ...errors(401, 403, 404, 409) },
});
const installed = createRoute({
  method: "get",
  path: "/api/v1/installations",
  tags: TAG,
  security: SECURITY,
  summary: "Integrations installed on your account: what each may do and on which repos",
  middleware: [humanOnly] as const,
  responses: {
    200: json(z.object({ installations: z.array(InstallationViewSchema) }), "Installations"),
    ...errors(401, 403),
  },
});
const updateRepos = createRoute({
  method: "patch",
  path: "/api/v1/installations/{installationId}",
  tags: TAG,
  security: SECURITY,
  summary: "Change which repos an installed integration reaches",
  middleware: [humanOnly, idempotent()] as const,
  request: {
    headers: IdempotencyHeaders,
    params: InstallationParam,
    body: body(InstallDecisionBody),
  },
  responses: {
    200: json(z.object({ installation: InstallationViewSchema }), "Updated"),
    ...errors(400, 401, 403, 404, 409),
  },
});
const uninstall = createRoute({
  method: "post",
  path: "/api/v1/installations/{installationId}/uninstall",
  tags: TAG,
  security: SECURITY,
  summary:
    "Uninstall: every token stops working now and no more events are sent (except installation.deleted)",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: InstallationParam },
  responses: {
    200: json(z.object({ installation: InstallationViewSchema }), "Uninstalled"),
    ...errors(401, 403, 404),
  },
});
const self = createRoute({
  method: "get",
  path: "/api/v1/installation",
  tags: TAG,
  security: [{ Bearer: [] }],
  summary:
    "Integration tokens: this installation, its account and its repositories (with clone URLs)",
  middleware: [requirePrincipal()] as const,
  responses: { 200: json(CurrentInstallationSchema, "Installation"), ...errors(401, 403, 404) },
});

export function registerInstallRoutes(app: ApiApp): void {
  app.openapi(getRequest, async (c) =>
    c.json(
      { install: await getInstallRequest(c.get("services"), callerOf(c), c.req.valid("param").id) },
      200,
    ),
  );
  app.openapi(approve, async (c) => {
    const out = await approveInstall(
      c.get("services"),
      urlsFor(c),
      callerOf(c),
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return c.json({ redirectTo: out.redirectTo }, 200);
  });
  app.openapi(deny, async (c) =>
    c.json(
      await denyInstall(c.get("services"), urlsFor(c), callerOf(c), c.req.valid("param").id),
      200,
    ),
  );
  app.openapi(installed, async (c) =>
    c.json({ installations: await listInstallations(c.get("services"), callerOf(c)) }, 200),
  );
  app.openapi(updateRepos, async (c) =>
    c.json(
      {
        installation: await updateInstallationRepos(
          c.get("services"),
          callerOf(c),
          c.req.valid("param").installationId,
          c.req.valid("json"),
        ),
      },
      200,
    ),
  );
  app.openapi(uninstall, async (c) =>
    c.json(
      {
        installation: await uninstallInstallation(
          c.get("services"),
          callerOf(c),
          c.req.valid("param").installationId,
        ),
      },
      200,
    ),
  );
  app.openapi(self, async (c) =>
    c.json(await currentInstallation(c.get("services"), callerOf(c)), 200),
  );
}
