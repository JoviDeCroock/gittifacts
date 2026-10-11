/**
 * Every URL an agent prints or reads first, over plain HTTP: the right representation for an
 * agent (markdown) and for a browser (HTML), discovery documents, the docs' machine files, and
 * the GitHub webhook refusing an unsigned delivery. Shared with the post-deploy smoke
 * (lib/front-door.ts) so production is checked with the same expectations.
 */

import { expect, test } from "../../lib/fixtures.js";
import { checkFrontDoor, checkWebhookRejectsBadSignature } from "../../lib/front-door.js";

test("front door: /start, /llms.txt, OpenAPI, MCP card, docs machine files", async ({
  request,
  baseURL,
}) => {
  const failures = await checkFrontDoor(request, baseURL as string);
  expect(failures).toEqual([]);
});

test("the GitHub webhook answers 401 to a bad signature", async ({ request, baseURL }) => {
  await checkWebhookRejectsBadSignature(request, baseURL as string);
});

test("health names the running version", async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/api/v1/health`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; version: string; commit: string | null };
  expect(body.ok).toBe(true);
  expect(typeof body.version).toBe("string");
});

test("an unknown API route is a JSON 404 with a fix, an unknown app path is the SPA", async ({
  request,
  baseURL,
}) => {
  const api = await request.get(`${baseURL}/api/v1/does-not-exist`);
  expect(api.status()).toBe(404);
  const body = (await api.json()) as { error: { code: string; fix: { explanation: string } } };
  expect(body.error.code).toBe("not-found");
  expect(body.error.fix.explanation.length).toBeGreaterThan(0);
  const app = await request.get(`${baseURL}/changes/chg_unknown`, {
    headers: { accept: "text/html" },
  });
  expect(app.status()).toBe(200);
  expect(app.headers()["content-type"]).toContain("text/html");
});
