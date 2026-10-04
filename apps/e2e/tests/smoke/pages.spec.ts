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
  await expect(page).toHaveURL((u) => u.pathname === "/dashboard"); // the path: "?next=/dashboard" also ends in /dashboard
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
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/signin/);
  const form = page.locator("form").filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(EMAIL);
  await form.locator('input[type="password"]').fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  // The path, not the URL: "/signin?next=/dashboard" also ends in "/dashboard".
  await expect(page).toHaveURL((u) => u.pathname === "/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const shot = async (name: string) => {
    const body = await page.screenshot();
    await testInfo.attach(`${name}-${testInfo.project.name}.png`, { body, contentType: "image/png" });
  };
  // Shoot the loaded dashboard, not its skeleton.
  await expect(page.getByTestId("first-run-checklist").or(page.getByRole("main").getByRole("list")).first()).toBeVisible();
  await shot("dashboard");

  // Find a Change the way a person does: a link on the dashboard, else on the first repo's page.
  // Read-only, and never a reason to fail the smoke when the account simply has no Change yet.
  let href = await page.locator('a[href^="/changes/"]').first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
  if (href === null) {
    const repo = await page.locator('a[href^="/repos/"]').first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
    if (repo !== null) {
      await page.goto(repo);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      href = await page.locator('a[href^="/changes/"]').first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
    }
  }
  test.skip(href === null, "no Change linked from the E2E account's dashboard or first repo");
  await page.goto(href!.split("#")[0]!);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("lane-block").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot("change");
});
