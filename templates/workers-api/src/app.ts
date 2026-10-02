/**
 * Routes for the API. Pure: takes a Request (and the bindings), returns a Response. Add routes to
 * `routes`.
 */

import type { Env } from "./index.js";

type Handler = (request: Request, url: URL, env: Env) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** GET routes by exact path. */
export const routes: Record<string, Handler> = {
  "/": () => json({ now: new Date().toISOString() }),
  "/health": () => json({ ok: true }),
};

export async function handle(request: Request, env: Env = {}): Promise<Response> {
  const url = new URL(request.url);
  const route = routes[url.pathname];
  if (route === undefined) return json({ error: "not found", path: url.pathname }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  return route(request, url, env);
}
