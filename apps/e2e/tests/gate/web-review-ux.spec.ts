/**
 * The walkthrough and its decision (UX audit 2026-10-11, review-flow findings 1-17, 26):
 *
 * - reading width: at 1280 the reading column stays wide (the rail waits for a 1040px tour), and
 *   once the rail joins the column is still at least 640px;
 * - keyboard: J/K put focus on the stop's heading; A opens the sheet on its title; Escape closes it
 *   and hands focus back to the choice;
 * - phones: Approve doesn't focus the optional comment (no keyboard over the sheet), the page behind
 *   the sheet is inert under a scrim, and the done sheet never covers the end of the page;
 * - agents: the owner of the authoring agent sees the boundary note, and can close the change (real
 *   Worker: POST /changes/:id/close records it).
 *
 * States the hermetic server can't produce (a five-stop walkthrough) come from the UI's demo backend
 * (`?mock`). Roles, test ids and seeded data only (docs/testing.md).
 */
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true }).first();

test("reading width: the column stays readable at 1280 and beside the rail (demo data)", async ({
  authed: page,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "desktop widths");
  await page.goto("/changes/chg_tz7k2?mock");
  const main = page.getByTestId("tour-main");
  await expect(main).toBeVisible();
  // Next to the 248px sidebar, 1280 is below the rail: one wide column, the decision in the bar.
  await expect(page.getByTestId("tour-rail")).toHaveCount(0);
  expect((await main.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(600);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("tour-rail")).toBeVisible();
  expect((await main.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(640);
  await expectNoHorizontalScroll(page);
});

test("keyboard: J/K focus the stop heading, A opens the decision on its title, Escape closes it (demo data)", async ({
  authed: page,
}) => {
  await page.goto("/changes/chg_tz7k2?mock");
  await expect(visible(page, "decision-approve")).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { level: 2, name: /Stop 2 of 5/ })).toBeFocused();
  await expect(page.getByTestId("stations-count")).toContainText("Stop 2 of 5");
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", { level: 2, name: /Stop 1 of 5/ })).toBeFocused();

  await page.keyboard.press("a");
  const form = page.getByTestId("decision-form");
  await expect(form).toBeVisible();
  await expect(form.getByRole("heading", { name: "Approve this change" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(visible(page, "decision-approve")).toBeFocused();
});

test("phones: Approve keeps the keyboard down, the page behind the sheet is inert, a tap on it is Back (demo data)", async ({
  authed: page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "the bottom sheet");
  await page.goto("/changes/chg_tz7k2?mock");
  await visible(page, "decision-approve").click();
  const form = page.getByTestId("decision-form");
  await expect(form.getByRole("heading", { name: "Approve this change" })).toBeFocused();
  await expect(form.getByRole("textbox")).not.toBeFocused();
  await expect(page.getByTestId("tour-layout")).toHaveAttribute("inert", "");
  await page.getByTestId("decision-scrim").click({ position: { x: 20, y: 120 } });
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("tour-layout")).not.toHaveAttribute("inert", "");

  // Request changes needs a comment, so that one does take the field.
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(form.getByRole("textbox")).toBeFocused();
});

test("after a decision the done sheet never covers the end of the page (demo data)", async ({
  authed: page,
}) => {
  // Both gate widths use the bar: 1280 is below the rail.
  await page.goto("/changes/chg_tz7k2?mock");
  await visible(page, "decision-approve").click();
  await page.getByTestId("decision-confirm").click();
  await expect(page.getByTestId("decision-done")).toBeVisible();
  await expect(page.getByTestId("next-up")).toBeVisible();
  await expect(page.getByTestId("tour-layout")).not.toHaveAttribute("inert", "");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const last = page.getByTestId("tour-main").locator(":scope > :last-child");
  await expect
    .poll(async () => {
      const [end, bar] = await Promise.all([
        last.boundingBox(),
        page.getByTestId("decision-bar").boundingBox(),
      ]);
      return end && bar ? bar.y - (end.y + end.height) : -1;
    })
    .toBeGreaterThanOrEqual(0);
  await expectNoHorizontalScroll(page);
});

test("the owner of the authoring agent sees the boundary, and can close the change (real Worker)", async ({
  authed: page,
  request,
  baseURL,
  human,
  agentWork,
}) => {
  await page.goto(`/changes/${agentWork.changeId}`);
  await expect(visible(page, "decision-approve")).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.getByTestId("decision-own-agent").filter({ visible: true })).toContainText(
    "Your agent",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("decision-form")).toHaveCount(0);
  // A then Escape straight away: focus is already in the sheet, so the Escape closes it.
  await page.keyboard.press("a");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("decision-form")).toHaveCount(0);

  await visible(page, "close-change-open").click();
  const form = page.getByTestId("close-change-form");
  await expect(form.getByRole("heading", { name: "Close this change?" })).toBeVisible();
  await form.getByRole("textbox").fill("Superseded by a smaller change.");
  await page.getByTestId("close-change-confirm").click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("close-change-open")).toHaveCount(0);

  const res = await request.get(`${baseURL}/api/v1/changes/${agentWork.changeId}`, {
    headers: { cookie: human.cookie },
  });
  expect(((await res.json()) as { change: { status: string } }).change.status).toBe("abandoned");
});
