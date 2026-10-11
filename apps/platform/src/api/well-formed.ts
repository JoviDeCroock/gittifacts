/**
 * Every JSON request body must be well-formed Unicode (security audit 2026-10-11, M10).
 *
 * A JSON escape such as "\ud800" decodes to a lone UTF-16 surrogate. Canonical JSON (the hash input
 * of the audit chain, plan approvals and evidence) rejects lone surrogates, so a request carrying
 * one could commit a state change and then fail its audit append. This guard runs before auth and
 * validation for the HTTP API and MCP alike, so no handler ever sees such a string.
 *
 * Raw body bytes are decoded as UTF-8 with replacement, which is always well-formed, so a lone
 * surrogate can only arrive through a `\uD800`–`\uDFFF` escape: bodies without one skip the parse.
 */
import { findLoneSurrogate } from "@app/evidence";
import type { MiddlewareHandler } from "hono";
import { fixFor } from "../errors.js";

const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;
const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The JSON pointer of the first lone surrogate in a JSON body, or null (also for non-JSON). */
export function loneSurrogateIn(text: string): string | null {
  if (!SURROGATE_ESCAPE.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // not JSON: the route's own validation rejects it
  }
  return findLoneSurrogate(parsed);
}

function jsonRpcId(text: string): string | number | null {
  try {
    const m = JSON.parse(text) as { id?: unknown };
    return typeof m?.id === "string" || typeof m?.id === "number" ? m.id : null;
  } catch {
    return null;
  }
}

export function wellFormedJsonBody(opts: { mcpPath: string }): MiddlewareHandler {
  return async (c, next) => {
    if (BODYLESS.has(c.req.method) || !/json/i.test(c.req.header("content-type") ?? "")) {
      return next();
    }
    const text = await c.req.raw.clone().text();
    const at = loneSurrogateIn(text);
    if (at === null) return next();
    const message = `request body has a lone UTF-16 surrogate at ${at}`;
    const explanation =
      "Text must be well-formed Unicode: send emoji and other astral characters as a complete surrogate pair (or plain UTF-8), never half of one.";
    if (new URL(c.req.url).pathname === opts.mcpPath) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: jsonRpcId(text),
          error: { code: -32602, message, data: { explanation } },
        },
        400,
      );
    }
    return c.json(
      {
        error: {
          code: "invalid-request",
          message,
          fix: fixFor("invalid-request", { explanation }),
          details: [{ path: at, message: "lone UTF-16 surrogate" }],
        },
      },
      400,
    );
  };
}
