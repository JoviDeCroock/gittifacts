/**
 * The landing page signed out and signed in, sign-in through the real form, and the redirects
 * every printed link relies on: signed-out app URLs go to /signin?next=…, and signing in lands on
 * `next` (never on another origin).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

async function signInThroughForm(page: import("@playwright/test").Page, email: string, password: string) {
  const form = page.locator("form").filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(email);
  await form.locator('input[type="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
}

test.describe("landing /", () => {
  test("signed out: the pitch, and the session link goes to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const session = page.locator("a[data-session-link]").first();
    await expect(session).toHaveAttribute("href", "/signin");
    await expectNoHorizontalScroll(page);
  });

  test("signed in: the session link says where the dashboard is, and it opens", async ({ authed: page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-authed", "");
    const links = page.locator("a[data-session-link]");
    await expect(links.first()).toHaveAttribute("href", "/dashboard");
    await page.goto((await links.first().getAttribute("href")) as string);
    await expect(page).toHaveURL((u) => u.pathname === "/dashboard"); // the path: "?next=/dashboard" also ends in /dashboard
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("redirects", () => {
  test("signed out /dashboard → /signin → the dashboard after signing in", async ({ page, human }) => {
    await page.goto("/dashboard");
    // The dashboard is where sign-in lands anyway, so it needs no `next`.
    await expect(page).toHaveURL(/\/signin(\?next=%2Fdashboard)?$/);
    await signInThroughForm(page, human.email, human.password);
    await expect(page).toHaveURL((u) => u.pathname === "/dashboard"); // the path: "?next=/dashboard" also ends in /dashboard
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("a printed Change link survives sign-in", async ({ page, human, world }) => {
    await page.goto(`/changes/${world.changeId}`);
    await expect(page).toHaveURL(new RegExp(`/signin\\?next=${encodeURIComponent(`/changes/${world.changeId}`)}$`));
    await signInThroughForm(page, human.email, human.password);
    await expect(page).toHaveURL(new RegExp(`/changes/${world.changeId}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("signed in, /signin?next= goes straight to next; another origin is refused", async ({ authed: page, world }) => {
    await page.goto(`/signin?next=${encodeURIComponent(`/plans/${world.planId}`)}`);
    await expect(page).toHaveURL(new RegExp(`/plans/${world.planId}$`));
    await page.goto(`/signin?next=${encodeURIComponent("//evil.example/x")}`);
    await expect(page).toHaveURL((u) => u.pathname === "/dashboard"); // the path: "?next=/dashboard" also ends in /dashboard
  });

  test("an unknown claim link is a page, not a crash", async ({ page }) => {
    await page.goto("/claim/gtc_does_not_exist");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
