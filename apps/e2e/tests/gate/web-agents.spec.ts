/**
 * Agents as first-class actors in the web app, on a Change an agent pushed through the real
 * pipeline: the dashboard's agent band shows the agent and opens what it acted on; the palette's
 * two hands (a person runs a command, an agent gets its MCP twin; approving stays a person's);
 * the walkthrough's keys (J moves a stop, A opens the decision and never signs); and the next
 * change offered after a decision. Roles, test ids and seeded data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

test("dashboard: the agent band shows the agent that just worked", async ({ authed: page, agentWork }) => {
  await page.goto("/dashboard");
  const band = page.getByTestId("fleet");
  await expect(band).toBeVisible();
  const row = band.getByTestId("fleet-agent").first();
  await expect(row).toHaveAttribute("data-state", /^(waiting|working)$/);
  await expectNoHorizontalScroll(page);
  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/(changes/${agentWork.changeId}|repos/${agentWork.repoId})`));
});

test("palette: a person runs a command, an agent gets its twin, approving stays a person's", async ({ authed: page, agentWork }) => {
  await page.goto(`/changes/${agentWork.changeId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The sidebar field on desktop, the top bar's search button on phones.
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();

  await palette.getByTestId("palette-mode-agent").click();
  await expect(palette).toHaveAttribute("data-mode", "agent");
  await expect(palette.locator('[data-command="change.approve"]')).toHaveAttribute("aria-disabled", "true");
  await expect(palette.locator('[data-command="change.rerun"]')).toBeVisible();
  await page.keyboard.type("evidence");
  await expect(palette.getByTestId("palette-mcp")).toHaveText(`get_evidence({ "changeId": "${agentWork.changeId}" })`);

  await palette.getByTestId("palette-mode-me").click();
  await expect(palette.locator('[data-command="change.rerun"]')).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/changes/${agentWork.changeId}/evidence$`));
  await expect(palette).toBeHidden();

  // ⌘K / Ctrl+K toggles it from anywhere; Escape closes it.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("walkthrough keys: J and K step through the stops and the strip follows (demo data: four stops)", async ({ authed: page }) => {
  // The gate's fake reviewer writes one stop; the UI's demo backend has a four-stop walkthrough.
  await page.goto("/changes/chg_pd2n6?mock");
  await expect(page.getByTestId("decision-approve").first()).toBeVisible();
  const stations = page.getByRole("navigation", { name: "Walkthrough stops" }).getByRole("button");
  await expect(stations).toHaveCount(4);
  await expect(stations.nth(0)).toHaveAttribute("aria-current", "step");
  await page.keyboard.press("j");
  await expect(stations.nth(1)).toHaveAttribute("aria-current", "step");
  await page.keyboard.press("j");
  await expect(stations.nth(2)).toHaveAttribute("aria-current", "step");
  await page.keyboard.press("k");
  await expect(stations.nth(1)).toHaveAttribute("aria-current", "step");
  // The stop the strip names is the one on screen.
  await expect(page.locator("#stop-2")).toBeInViewport();
});

test("walkthrough keys: A opens the decision and never signs; then the next change", async ({ authed: page, agentWork }) => {
  await page.goto(`/changes/${agentWork.changeId}`);
  // The loading state has an h1 too ("Change"): wait for the decision, which comes with the walkthrough.
  await expect(page.getByTestId("decision-approve").first()).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.getByTestId("decision-confirm")).toBeVisible();
  await expect(page.getByTestId("decision-done")).toHaveCount(0);

  await page.getByTestId("decision-confirm").click();
  await expect(page.getByTestId("decision-done")).toHaveAttribute("data-decision", "approve");
  const next = page.getByTestId("next-up");
  await expect(next).toBeVisible();
  await expect(next.locator(`a[href="/repos/${agentWork.repoId}/queue"]`)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("rollout: on a phone the switch-off rides in the thumb zone and opens the form (demo data)", async ({ authed: page }, testInfo) => {
  await page.goto("/changes/chg_fx2r7/rollout?mock");
  await expect(page.getByRole("heading", { level: 2, name: /Switch off/ })).toBeAttached();
  const bar = page.getByTestId("kill-bar");
  if (testInfo.project.name !== "phone") {
    // From 1100px the side column holds the switch-off beside the health check.
    await expect(bar).toBeHidden();
    return;
  }
  await expect(bar).toBeVisible();
  await expect(bar).toBeInViewport();
  await bar.getByRole("button").click();
  await expect(page.locator("#switch-off textarea")).toBeFocused();
  await expect(bar).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
