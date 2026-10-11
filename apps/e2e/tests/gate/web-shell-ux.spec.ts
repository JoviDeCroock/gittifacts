/**
 * The app frame and the palette, on a Change an agent pushed through the real pipeline: exactly
 * one current place in the navigation (the repo, on its change too); the phone drawer carries
 * the repositories and search; the palette finds a change by its title and an id, and hands the
 * walkthrough to an agent as get_tour; the desktop top bar arrives once the page head scrolls
 * away; a dead address offers the palette. Roles, test ids and seeded data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

const TITLE = "Fix the off-by-one in a()";

test("navigation: exactly one current item, the repo you are in (desktop)", async ({ authed: page, agentWork }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "the sidebar is the desktop navigation; the drawer test covers phones");
  const nav = page.getByRole("complementary", { name: "Navigation" });
  for (const path of [`/repos/${agentWork.repoId}`, `/changes/${agentWork.changeId}`]) {
    await page.goto(path);
    await expect(page.getByTestId("decision-approve").or(page.getByRole("link", { name: "Merge queue" })).first()).toBeVisible();
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(agentWork.repoName);
    // Dashboard is the quiet ancestor here (DESIGN.md, sidebar); the brand mark also links home.
    const dashboard = nav.getByRole("navigation", { name: "Places" }).getByRole("link", { name: "Dashboard", exact: true });
    await expect(dashboard).not.toHaveAttribute("aria-current", /.+/);
    await expect(dashboard).toHaveAttribute("data-ancestor", "true");
  }
  await page.goto("/dashboard");
  await expect(nav.locator('[aria-current="page"]')).toHaveText("Dashboard");
});

test("phone drawer: the repositories with their counts, and search", async ({ authed: page, agentWork }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "the drawer is the phone navigation");
  await page.goto(`/repos/${agentWork.repoId}`);
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  await expect(drawer).toBeVisible();
  const repo = drawer.getByTestId("nav-repo").filter({ hasText: agentWork.repoName });
  await expect(repo).toHaveAttribute("aria-current", "page");
  const box = await repo.boundingBox();
  expect(box?.height ?? 0, "a 44px touch target").toBeGreaterThanOrEqual(44);
  await expect(drawer.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  // Its search field hands over to the palette: one sheet at a time.
  await drawer.getByTestId("palette-open").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(drawer).toBeHidden();
  await expectNoHorizontalScroll(page);
});

test("palette: finds a change by title or id; the walkthrough's agent twin is get_tour", async ({ authed: page, agentWork }) => {
  await page.goto("/dashboard");
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.getByTestId("palette-mode-me").click();
  // A pasted id offers the change (from anywhere but its own page, which the palette leaves out).
  await page.keyboard.type(agentWork.changeId);
  await expect(palette.locator('[data-command="jump.change"], [data-command^="open.change."]').first()).toBeVisible();
  await palette.getByRole("combobox").fill("");
  await page.keyboard.type("off-by-one");
  const row = palette.locator(`[data-command="open.change.${agentWork.changeId}"]`);
  await expect(row).toContainText(TITLE);
  await expect(row).toContainText(agentWork.repoName);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/changes/${agentWork.changeId}$`));
  await expect(palette).toBeHidden();

  // What's typed straight after ⌘K lands in the palette, not in the page's single-key shortcuts.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("walkthrough");
  await expect(palette.getByRole("combobox")).toHaveValue("walkthrough");
  await expect(page).toHaveURL(new RegExp(`/changes/${agentWork.changeId}$`));

  // The two hands are one radio group: arrows move the choice.
  await palette.getByTestId("palette-mode-me").focus();
  await page.keyboard.press("ArrowRight");
  await expect(palette).toHaveAttribute("data-mode", "agent");
  await expect(palette.getByTestId("palette-mode-agent")).toBeFocused();
  await palette.getByRole("combobox").fill("walkthrough");
  await expect(palette.getByTestId("palette-mcp")).toHaveText(`get_tour({ "changeId": "${agentWork.changeId}" })`);
  // Agent-only hand-offs are listed; approving stays a person's, with the rule said on Enter.
  await palette.getByRole("combobox").fill("");
  await expect(palette.locator('[data-command="change.request-review"]')).toContainText("request_review");
  await palette.getByRole("combobox").fill("approve");
  await page.keyboard.press("Enter");
  await expect(palette.getByRole("status")).toContainText(/only a person/i);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("desktop top bar: glass that arrives once the page head scrolls away", async ({ authed: page, agentWork }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "phones always show their top bar");
  await page.goto(`/repos/${agentWork.repoId}`);
  await expect(page.getByRole("heading", { level: 1, name: agentWork.repoName })).toBeVisible();
  const bar = page.getByTestId("topbar");
  await expect(bar).toBeHidden();
  await page.evaluate(() => {
    document.body.style.minHeight = "4000px";
    window.scrollTo(0, 600);
  });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("navigation", { name: "Where you are" })).toContainText(agentWork.repoName);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).toBeHidden();
});

test("not found: a dead address offers the palette, filled with what it asked for", async ({ authed: page, agentWork }) => {
  await page.goto(`/changes/${agentWork.changeId}/nowhere`);
  await page.getByTestId("notfound-search").click();
  const palette = page.getByTestId("palette");
  await expect(palette.getByRole("combobox")).toHaveValue(agentWork.changeId);
  await expect(palette.locator('[data-command="jump.change"]')).toBeVisible();
});
