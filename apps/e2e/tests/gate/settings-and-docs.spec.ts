/**
 * Settings (agents, integrations, GitHub) and the docs a newcomer opens first. Creating an agent
 * token is the step every agent onboarding depends on, so it runs for real.
 */
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";

test("agents: create an agent and see its token once", async ({ authed: page, request, baseURL, human }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const name = uniqueName("bot").toLowerCase();
  // Connecting an agent leads the rail; the hand-made form sits behind "Add one by hand…".
  await page.getByTestId("create-agent-open").click();
  const form = page.getByTestId("create-agent");
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  // Its repositories are a choice to make (this person has none yet, so: all, including later).
  await form.getByRole("radio", { name: /^All repositories you can access/ }).check();
  await form.locator('button[type="submit"]').click();
  // The token is shown once, in a field or code block that starts with the token prefix.
  await expect(page.getByText(/gtf_[A-Za-z0-9_-]{8,}/).first()).toBeVisible();
  const res = await request.get(`${baseURL}/api/v1/principals`, { headers: { cookie: human.cookie } });
  const body = (await res.json()) as { principals: Array<{ name: string; kind: string }> };
  expect(body.principals.some((p) => p.kind === "agent" && p.name === name)).toBe(true);
  await expectNoHorizontalScroll(page);
});

const SETTINGS = ["/settings/integrations", "/settings/integrations/developer", ...(GITHUB_SURFACES ? ["/settings/github"] : []), "/audit"];
for (const path of SETTINGS) {
  test(`settings page ${path} renders without errors`, async ({ authed: page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
}

test("GitHub surfaces switched off: no nav entry, no palette command, no page, no sign-in button", async ({ authed: page, browser, baseURL }) => {
  test.skip(GITHUB_SURFACES, "GitHub surfaces are on (@app/domain/surfaces)");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('a[href="/settings/github"]')).toHaveCount(0);
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.locator('[data-command="go.github"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/settings/github");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  // Signed out: email only.
  const ctx = await browser.newContext({ baseURL });
  const anon = await ctx.newPage();
  await anon.goto("/signin");
  await expect(anon.getByRole("button", { name: /email|sign in/i }).first()).toBeVisible();
  await expect(anon.getByRole("button", { name: /GitHub/ })).toHaveCount(0);
  await anon.goto("/docs");
  await expect(anon.locator('a[href="/docs/get-started/github"], a[href="/docs/get-started/from-github"]')).toHaveCount(0);
  await ctx.close();
});

test("docs: home, a getting-started page, and its markdown twin", async ({ page, request, baseURL }) => {
  await page.goto("/docs");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Follow the first getting-started link from the home page (whatever it is called today).
  const link = page.locator('a[href^="/docs/get-started/"]').filter({ visible: true }).first();
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href")) as string;
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const md = await request.get(`${baseURL}${href.replace(/\/$/, "")}.md`);
  expect(md.status()).toBe(200);
  expect(await md.text()).toMatch(/^(---|#)/);
});

test("the /start and /llms.txt pages render for a browser", async ({ page }) => {
  for (const path of ["/start", "/llms.txt"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});
