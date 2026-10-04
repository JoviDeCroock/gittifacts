/**
 * The way real accounts sign in (lib/auth.ts) must never put the password anywhere a report can
 * pick it up. A canary account signs up with E2E_CANARY_PASSWORD, signs in through signInWithApi,
 * and the test attaches everything a failure report would hold: the page's aria snapshot, its HTML
 * and a screenshot. In CI, scripts/check-report-secrets.mjs then scans the whole report for the
 * canary (deploy-gate.yml), so a sign-in that leaks fails the gate.
 */
import { request as playwrightRequest } from "@playwright/test";
import { signInWithApi } from "../../lib/auth.js";
import { expect, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";

const CANARY = process.env.E2E_CANARY_PASSWORD ?? "canary-local-only-0123456789";

test("signing in through the API puts no secret on the page or in the report", async ({ page, context, baseURL }, testInfo) => {
  const name = uniqueName("canary");
  const email = `${name}@e2e.invalid`;
  // Sign-up from a private request context too: the traced `request` fixture would put the
  // password in a trace's request log.
  const api = await playwrightRequest.newContext();
  const up = await api.post(`${baseURL}/api/auth/sign-up/email`, {
    data: { email, password: CANARY, name },
    headers: { origin: baseURL as string },
  });
  const ok = up.ok();
  await api.dispose();
  expect(ok).toBe(true);
  await signInWithApi(context, baseURL as string, email, CANARY);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const aria = await page.locator("body").ariaSnapshot();
  const html = await page.content();
  await testInfo.attach("aria.yml", { body: aria, contentType: "text/yaml" });
  await testInfo.attach("page.html", { body: html, contentType: "text/html" });
  await testInfo.attach("page.png", { body: await page.screenshot(), contentType: "image/png" });
  expect(aria.includes(CANARY) || html.includes(CANARY), "the password reached the page").toBe(false);
});
