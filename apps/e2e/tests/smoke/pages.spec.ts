/**
 * Post-deploy, in a browser (desktop and 390 px): landing, docs, /start as a page, and the
 * dedicated E2E account signing in through the real form and reaching a dashboard with its data.
 * Reads only; the account is never used to change anything.
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test("landing, docs and /start render", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("a[data-session-link]").first()).toHaveAttribute("href", "/signin");
  await expectNoHorizontalScroll(page);
  for (const path of ["/docs", "/start"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});

test("the E2E account signs in and sees its dashboard", async ({ page }) => {
  test.skip(EMAIL === "" || PASSWORD === "", "E2E_EMAIL / E2E_PASSWORD not configured");
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/signin/);
  const form = page.locator("form").filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(EMAIL);
  await form.locator('input[type="password"]').fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Real data: the dashboard's own API answers for this account, and the page shows its name.
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(200);
  const { principal } = (await me.json()) as { principal: { name: string; kind: string } };
  expect(principal.kind).toBe("human");
  // On a phone the account menu sits in the collapsed navigation: present, not necessarily shown.
  await expect(page.getByText(principal.name, { exact: false }).first()).toBeAttached();
  await expect(page.getByTestId("first-run-checklist").or(page.getByRole("main").getByRole("list")).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

/**
 * Signed-in screens a reviewer reads first, as the E2E account: the dashboard and its newest Change,
 * at both widths. Screenshots are kept in the report (review aid for copy changes such as the
 * 2026-10-04 terms); the assertions are on roles, test ids and the account's own data, never copy.
 */
test("the E2E account's dashboard and newest Change page render", async ({ page }, testInfo) => {
  test.skip(EMAIL === "" || PASSWORD === "", "E2E_EMAIL / E2E_PASSWORD not configured");
  await page.goto("/signin?next=/dashboard");
  const form = page.locator("form").filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(EMAIL);
  await form.locator('input[type="password"]').fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const shot = async (name: string) => {
    const body = await page.screenshot();
    await testInfo.attach(`${name}-${testInfo.project.name}.png`, { body, contentType: "image/png" });
  };
  await shot("dashboard");

  const reposRes = await page.request.get("/api/v1/repos");
  expect(reposRes.status()).toBe(200);
  const { repos } = (await reposRes.json()) as { repos: { id: string }[] };
  let newest: { id: string; updatedAt: string } | null = null;
  for (const r of repos.slice(0, 20)) {
    const res = await page.request.get(`/api/v1/repos/${encodeURIComponent(r.id)}/changes`);
    if (res.status() !== 200) continue;
    const { changes } = (await res.json()) as { changes: { id: string; updatedAt: string }[] };
    for (const c of changes) if (newest === null || c.updatedAt > newest.updatedAt) newest = c;
  }
  test.skip(newest === null, "the E2E account has no Change yet (the nightly suites create them)");
  await page.goto(`/changes/${encodeURIComponent(newest!.id)}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("lane-block").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot("change");
});
