/**
 * Comparing attempts at one plan on the UI's demo backend (`?mock`): three agents attempted
 * plan_ratelimit on edge-router (Lane 1 green and small, Lane 2 with scope drift, failing tests).
 * The plan page ranks them best first with the recommended one on top; the palette offers the
 * compare_attempts twin and keeps the pick person-only; one tap on "Pick this one" approves the
 * recommended attempt and closes the other two as superseded. Roles, test ids and demo data only
 * (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

const PLAN = "/plans/plan_ratelimit";
const SMALL = "chg_rl1k4";
const DRIFT = "chg_rl2d7";
const FAILING = "chg_rl3f2";

test("attempts: ranked best first, the recommended one on top, the failing one last (demo data)", async ({ authed: page }) => {
  await page.goto(`${PLAN}?mock`);
  const section = page.getByTestId("attempts");
  await expect(section).toBeVisible();
  const cards = section.getByTestId("attempt-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-change-id", SMALL);
  await expect(cards.nth(1)).toHaveAttribute("data-change-id", DRIFT);
  await expect(cards.nth(2)).toHaveAttribute("data-change-id", FAILING);

  const first = cards.nth(0);
  await expect(first).toHaveAttribute("data-recommended", "true");
  await expect(first.getByTestId("attempt-recommended")).toHaveText("Recommended");
  await expect(first.getByTestId("attempt-reasons")).toContainText("red/green proven");
  await expect(first.locator(`a[href="/changes/${SMALL}"]`)).toBeVisible();
  await expect(cards.nth(1).getByTestId("attempt-reasons")).toContainText("scope drift");
  await expect(cards.nth(2).getByTestId("attempt-reasons")).toContainText("2 tests failing");

  // Pickable: the two awaiting review. The failing one has nothing to pick.
  await expect(first.getByTestId("attempt-pick")).toBeVisible();
  await expect(cards.nth(1).getByTestId("attempt-pick")).toBeVisible();
  await expect(cards.nth(2).getByTestId("attempt-pick")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("attempts: the palette compares with an agent twin and keeps the pick person-only (demo data)", async ({ authed: page }) => {
  await page.goto(`${PLAN}?mock`);
  await expect(page.getByTestId("attempts")).toBeVisible();
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  const palette = page.getByTestId("palette");
  await palette.getByTestId("palette-mode-agent").click();
  await page.keyboard.type("attempt");
  await expect(palette.locator('[data-command="plan.attempts"] .palette__tool')).toHaveText("compare_attempts");
  await expect(palette.getByTestId("palette-mcp")).toHaveText('compare_attempts({ "planId": "plan_ratelimit" })');
  const pick = palette.locator('[data-command="plan.pick"]');
  await expect(pick).toContainText("Only a person");
  // Locked for an agent (aria-disabled): arrow onto it to read the rule instead of a twin.
  await page.keyboard.press("ArrowDown");
  await expect(pick).toHaveAttribute("aria-selected", "true");
  await expect(palette.getByTestId("palette-twin")).toContainText("Agents never approve");

  // Yourself: the compare command brings the section into view.
  await palette.getByTestId("palette-mode-me").click();
  await palette.getByRole("combobox").fill("compare attempts");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${PLAN}#attempts$`));
  await expect(page.getByTestId("attempts")).toBeInViewport();
});

test("attempts: one tap picks the recommended attempt, approves it and closes the others (demo data)", async ({ authed: page }) => {
  await page.goto(`${PLAN}?mock`);
  const section = page.getByTestId("attempts");
  const first = section.getByTestId("attempt-card").and(page.locator(`[data-change-id="${SMALL}"]`));
  await first.getByTestId("attempt-pick").click();

  const done = section.getByTestId("attempts-picked");
  await expect(done).toBeVisible();
  await expect(done).toContainText("Picked and approved fleet-coder-12's attempt.");
  await expect(done).toContainText("2 other attempts closed as superseded.");
  await expect(first).toHaveAttribute("data-picked", "true");
  await expect(first).toHaveAttribute("data-status", "approved");
  for (const id of [DRIFT, FAILING]) {
    const card = section.getByTestId("attempt-card").and(page.locator(`[data-change-id="${id}"]`));
    await expect(card).toHaveAttribute("data-standing", "closed");
    await expect(card).toContainText("Superseded");
  }
  await expect(section.getByTestId("attempt-pick")).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // The approval is real in the demo backend: the change page says so.
  await first.locator(`a[href="/changes/${SMALL}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/changes/${SMALL}$`));
  await expect(page.getByText("Approved").first()).toBeVisible();
});
