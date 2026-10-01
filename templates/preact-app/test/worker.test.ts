import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker.js";

const assets: Env["ASSETS"] = { fetch: async () => new Response("<!doctype html>", { status: 200 }) };
const get = (path: string, method = "GET") =>
  worker.fetch(new Request(`https://example.test${path}`, { method }), { ASSETS: assets });

describe("worker", () => {
  it("serves the time from /api/time", async () => {
    const res = await get("/api/time");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { now: string };
    expect(new Date(body.now).toISOString()).toBe(body.now);
  });

  it("returns 404 JSON for unknown API paths", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", path: "/api/nope" });
  });

  it("rejects non-GET API calls", async () => {
    expect((await get("/api/time", "POST")).status).toBe(405);
  });

  it("falls through to static assets", async () => {
    const res = await get("/");
    expect(await res.text()).toBe("<!doctype html>");
  });
});
