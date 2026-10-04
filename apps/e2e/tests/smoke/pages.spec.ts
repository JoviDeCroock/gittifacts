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
