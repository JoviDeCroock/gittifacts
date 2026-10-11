/**
 * Lane reasons folded for people, on the UI's demo backend (`?mock`): the reasons that set the
 * lane read first, the ones that raised it next, and the checks that passed fold into "N checks
 * passed". chg_tz7k2 (billing-api) is a proven fix whose five reasons all pass (calibrating
 * routes it to a person); chg_lc3m9 mixes reasons that raise the lane with passing checks.
 * Roles, test ids and demo data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

test("walkthrough: passing checks fold under the result (demo data)", async ({ page }) => {
  await page.goto("/changes/chg_tz7k2?mock");
  const block = page.getByTestId("lane-block").filter({ visible: true }).first();
  await expect(block).toBeVisible();
  const why = block.locator("details.lane-block__why");
  if (!(await why.evaluate((d) => (d as HTMLDetailsElement).open))) await why.locator("summary").first().click();
  await expect(why.locator("summary").first()).toContainText("5 passed");
  const passed = why.getByTestId("triage-passed");
  await expect(passed.locator("summary")).toContainText("5 checks passed");
  // Folded: closed until asked, so the reasons that matter read first.
  await expect(passed).not.toHaveAttribute("open", "");
  await passed.locator("summary").click();
  await expect(passed.getByTestId("triage-row")).toHaveCount(5);
  await expectNoHorizontalScroll(page);
});

test("evidence: why this lane, the raising reasons first and the passing ones folded (demo data)", async ({ page }) => {
  await page.goto("/changes/chg_lc3m9/evidence?mock");
  const lane = page.getByTestId("ev-lane");
  await expect(lane.getByRole("heading", { name: /Why this review lane/ })).toBeVisible();
  const shown = lane.locator(".triage__grid").first().getByTestId("triage-row");
  await expect(shown.first()).toBeVisible();
  const lanes = await shown.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-lane"))));
  expect(lanes.length).toBeGreaterThan(0);
  expect(lanes.every((l) => l > 0), "only raising reasons above the fold").toBe(true);
  expect([...lanes].sort((a, b) => b - a), "deciding first").toEqual(lanes);
  await expect(lane.getByTestId("triage-passed").locator("summary")).toContainText(/\d+ checks? passed/);
  // The attestation is a term with its hint.
  await expect(page.locator('[data-term="attestation"]').getByTestId("term")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
