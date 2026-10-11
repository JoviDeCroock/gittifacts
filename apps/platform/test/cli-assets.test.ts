/**
 * /cli: the CLI tarball from the static assets (packages/cli pack:assets) with a gzip content
 * type, real 404s instead of the SPA fallback, and HEAD for `curl -I`. The canonical path is
 * /cli/v2/gittifacts.tgz; the pre-v2 /cli/gittifacts.tgz answers with the same (v2) file.
 * /cli/version.json is what the CLI's self-update checks.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeApp, ORIGIN } from "./http.js";

const TGZ = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
const SHA = "a".repeat(64);
const FILES: Record<string, [string, BodyInit]> = {
  // Only the v2 file exists: pack:assets no longer writes the old path.
  "/cli/v2/gittifacts.tgz": ["application/octet-stream", TGZ],
  "/cli/gittifacts-0.1.0.tgz": ["application/octet-stream", TGZ],
  "/cli/latest.json": [
    "application/json",
    JSON.stringify({ name: "gittifacts", version: "0.1.0" }),
  ],
  "/cli/version.json": [
    "application/json",
    JSON.stringify({ name: "gittifacts", version: "0.1.0", sha256: SHA, size: 10 }),
  ],
};

/** The assets binding as configured (not_found_handling: single-page-application). */
const assets = {
  async fetch(input: Request | string | URL): Promise<Response> {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      .pathname;
    const hit = FILES[path];
    if (hit) return new Response(hit[1], { headers: { "content-type": hit[0] } });
    return new Response("<!doctype html><div id=app></div>", {
      headers: { "content-type": "text/html" },
    });
  },
};

async function get(path: string, method = "GET") {
  const { app } = makeApp();
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { method, redirect: "manual" });
  const res = await app.fetch(req, { ...env, ASSETS: assets as unknown as Fetcher }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("/cli", () => {
  it("serves the latest tarball as gzip with a short cache, at v2 and the old path", async () => {
    for (const path of ["/cli/v2/gittifacts.tgz", "/cli/gittifacts.tgz"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="gittifacts.tgz"');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(TGZ);
    }
  });

  it("serves version.json (the self-update check) as JSON with a short cache", async () => {
    const res = await get("/cli/version.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.json()).toMatchObject({ sha256: SHA, size: 10 });
  });

  it("serves the build under its version, and latest.json", async () => {
    const pinned = await get("/cli/gittifacts-0.1.0.tgz");
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("content-type")).toBe("application/gzip");
    const latest = await get("/cli/latest.json");
    expect(latest.headers.get("content-type")).toContain("application/json");
    expect(await latest.json()).toMatchObject({ version: "0.1.0" });
  });

  it("answers HEAD without a body", async () => {
    const res = await get("/cli/v2/gittifacts.tgz", "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(await res.text()).toBe("");
  });

  it("is a real 404 for anything else, never the SPA", async () => {
    for (const path of [
      "/cli/gittifacts-9.9.9.tgz",
      "/cli/other.tgz",
      "/cli/x",
      "/cli/v3/gittifacts.tgz",
      "/cli/v2/version.json",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toContain(`${ORIGIN}/cli/v2/gittifacts.tgz`);
    }
  });

  it("sends /cli to the CLI guide", async () => {
    const res = await get("/cli");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/docs/get-started/cli");
  });
});
