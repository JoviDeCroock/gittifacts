/** JSON API under /api/*. Pure: takes a Request, returns a Response. */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function handleApi(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  switch (pathname) {
    case "/api/time":
      return json({ now: new Date().toISOString() });
    case "/api/health":
      return json({ ok: true });
    default:
      return json({ error: "not found", path: pathname }, 404);
  }
}
