import { nowAt } from "./clock.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/") return json({ error: "not found", path: url.pathname }, 404);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    try {
      return json({ now: nowAt(offset) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
};
