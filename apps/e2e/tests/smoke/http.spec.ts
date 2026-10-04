/**
 * Post-deploy: the deployment is the one just made, it is healthy, and every URL an agent reads
 * first answers the way the pre-deploy gate checked (same expectations, lib/front-door.ts).
 */
import { checkFrontDoor, checkWebhookRejectsBadSignature } from "../../lib/front-door.js";
import { expect, test } from "../../lib/fixtures.js";

test("health: alive, and the live version is the commit just deployed", async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/api/v1/health`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; version: string; commit: string | null };
  expect(body.ok).toBe(true);
  const want = process.env.SMOKE_EXPECT_COMMIT ?? "";
  if (want !== "") {
    // Unknown escalates: a missing tag fails like a wrong one.
    expect(body.commit, "the live version's commit tag").toBe(want);
  } else {
    test.info().annotations.push({ type: "warning", description: "SMOKE_EXPECT_COMMIT unset: version not compared" });
  }
  // The header every response carries names the same version.
  const start = await request.get(`${baseURL}/start`);
  expect(start.headers()["x-gittifacts-version"]).toBe(body.version);
});

test("front door and docs: every URL agents read first", async ({ request, baseURL }) => {
  expect(await checkFrontDoor(request, baseURL as string)).toEqual([]);
});

test("the GitHub webhook refuses a bad signature (401)", async ({ request, baseURL }) => {
  await checkWebhookRejectsBadSignature(request, baseURL as string);
});
