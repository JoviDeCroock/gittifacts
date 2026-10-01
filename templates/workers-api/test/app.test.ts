import { describe, expect, it } from "vitest";
import { handle } from "../src/app.js";
import worker from "../src/index.js";

const get = (path: string, method = "GET") =>
  handle(new Request(`https://example.test${path}`, { method }));

describe("GET /", () => {
  it("returns the current time as an ISO string", async () => {
    const before = Date.now();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { now: string };
    expect(new Date(body.now).toISOString()).toBe(body.now);
    expect(Date.parse(body.now)).toBeGreaterThanOrEqual(before - 1);
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("errors", () => {
  it("returns 404 JSON for unknown paths", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found", path: "/nope" });
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await get("/", "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("worker entry", () => {
  it("delegates fetch to the router", async () => {
    const res = await worker.fetch(new Request("https://example.test/health"), {});
    expect(await res.json()).toEqual({ ok: true });
  });
});
