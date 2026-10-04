/**
 * Settings (agents, integrations, GitHub) and the docs a newcomer opens first. Creating an agent
 * token is the step every agent onboarding depends on, so it runs for real.
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";

test("agents: create an agent and see its token once", async ({ authed: page, request, baseURL, human }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const name = uniqueName("bot").toLowerCase();
  const form = page.locator("form").filter({ has: page.getByRole("textbox") }).first();
  await form.getByRole("textbox").first().fill(name);
  await form.locator('button[type="submit"]').click();
  // The token is shown once, in a field or code block that starts with the token prefix.
  await expect(page.getByText(/gtf_[A-Za-z0-9_-]{8,}/).first()).toBeVisible();
  const res = await request.get(`${baseURL}/api/v1/principals`, { headers: { cookie: human.cookie } });
  const body = (await res.json()) as { principals: Array<{ name: string; kind: string }> };
  expect(body.principals.some((p) => p.kind === "agent" && p.name === name)).toBe(true);
  await expectNoHorizontalScroll(page);
});

for (const path of ["/settings/integrations", "/settings/integrations/developer", "/settings/github", "/audit"]) {
  test(`settings page ${path} renders without errors`, async ({ authed: page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
}

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
