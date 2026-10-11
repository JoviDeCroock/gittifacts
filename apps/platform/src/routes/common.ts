import { OpenAPIHono } from "@hono/zod-openapi";
import type { z } from "zod";
import { ErrorSchema } from "../api/schemas.js";
import { wellFormedJsonBody } from "../api/well-formed.js";
import type { AppEnv } from "../app-env.js";
import { fixFor, zodIssues } from "../errors.js";
import { MCP_PATH } from "../mcp/route.js";

export type ApiApp = OpenAPIHono<AppEnv>;

const ERROR_DESCRIPTIONS = {
  400: "Invalid request",
  401: "Not authenticated",
  403: "Forbidden (missing scope, not a human, or self-approval)",
  404: "Not found",
  409: "Conflict with the current state",
  415: "Content-Type must be application/json",
  429: "Rate limited (see retryAfterSec and the Retry-After header)",
  502: "Upstream (coordinator, Cloudflare) failed",
  503: "Not available in this deployment",
} as const;
type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

type ErrorResponse = {
  description: string;
  content: { "application/json": { schema: typeof ErrorSchema } };
};

/** OpenAPI error responses for the given statuses (all use the shared envelope). */
export function errors<const C extends readonly ErrorStatus[]>(
  ...codes: C
): { [K in C[number]]: ErrorResponse } {
  const out: Partial<Record<ErrorStatus, ErrorResponse>> = {};
  for (const code of codes) {
    out[code] = {
      description: ERROR_DESCRIPTIONS[code],
      content: { "application/json": { schema: ErrorSchema } },
    };
  }
  return out as { [K in C[number]]: ErrorResponse };
}

export function json<S extends z.ZodType>(schema: S, description: string) {
  return { description, content: { "application/json": { schema } } };
}

export function body<S extends z.ZodType>(schema: S) {
  return { content: { "application/json": { schema } }, required: true };
}

export const SECURITY: { [scheme: string]: string[] }[] = [{ Session: [] }, { Bearer: [] }];

export function newApiApp(): ApiApp {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "invalid-request",
              message: "request failed validation",
              fix: fixFor("invalid-request"),
              details: zodIssues(result.error),
            },
          },
          400,
        );
      }
    },
  });
  // Before auth and validation: no handler (HTTP or MCP) sees a lone UTF-16 surrogate (M10).
  app.use("*", wellFormedJsonBody({ mcpPath: MCP_PATH }));
  return app;
}
