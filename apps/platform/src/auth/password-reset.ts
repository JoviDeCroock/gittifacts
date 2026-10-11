/**
 * Password reset, around better-auth's own endpoints (DECISIONS 2026-10-11):
 *
 *   GET  /api/v1/sign-in-options            public: what the sign-in page may offer here
 *   POST /api/auth/request-password-reset   better-auth when e-mail is configured (./email.ts);
 *                                           otherwise 503 `not-configured` with a fix
 *
 * With e-mail configured, better-auth sends the link (always "if this e-mail exists…", so the
 * endpoint is no account oracle), /api/auth/reset-password/<token> redirects to the web form and
 * POST /api/auth/reset-password sets the password and signs the account out everywhere.
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { type ApiApp, json } from "../routes/common.js";
import { emailConfigured } from "./email.js";

export const RESET_REQUEST_PATH = "/api/auth/request-password-reset";

const SignInOptions = z
  .object({
    passwordReset: z
      .boolean()
      .describe("A forgotten password can be reset by e-mail (outbound e-mail is configured)"),
  })
  .meta({ id: "SignInOptions" });

const options = createRoute({
  method: "get",
  path: "/api/v1/sign-in-options",
  tags: ["identity"],
  summary: "What the sign-in page may offer on this deployment (no sign-in needed)",
  responses: { 200: json(SignInOptions, "Sign-in options") },
});

export function resetNotConfigured(): ApiError {
  return new ApiError(
    503,
    "not-configured",
    "password reset is not available on this deployment: it has no outbound e-mail",
    undefined,
    {
      explanation:
        "This deployment can't send e-mail, so it can't send a reset link. Ask whoever runs it for help, or to configure outbound e-mail (docs/deploy.md, \"Outbound e-mail\").",
    },
  );
}

/** Register BEFORE the `/api/auth/*` handler: the guard must run first. */
export function registerPasswordResetRoutes(app: ApiApp): void {
  app.openapi(options, (c) =>
    c.json({ passwordReset: emailConfigured(c.env) }, 200, {
      "cache-control": "no-store",
    }),
  );
  app.use(RESET_REQUEST_PATH, async (c, next) => {
    if (!emailConfigured(c.env)) throw resetNotConfigured();
    await next();
  });
}
