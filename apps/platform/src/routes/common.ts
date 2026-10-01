import { OpenAPIHono } from "@hono/zod-openapi";
import type { z } from "zod";
import { ErrorSchema } from "../api/schemas.js";
import type { AppEnv } from "../app-env.js";
import { fixFor, zodIssues } from "../errors.js";

export type ApiApp = OpenAPIHono<AppEnv>;

const ERROR_DESCRIPTIONS = {
  400: "Invalid request",
  401: "Not authenticated",
  403: "Forbidden (missing scope, not a human, or self-approval)",
  404: "Not found",
  409: "Conflict with the current state",
  415: "Content-Type must be application/json",
  502: "Upstream (coordinator, Cloudflare) failed",
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
  return new OpenAPIHono<AppEnv>({
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
}
