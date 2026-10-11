/**
 * Mission control (/repos/:repoId/mission) on the UI's demo backend (`?mock`): a busy repo needs
 * many agents at different stages, which the hermetic server can't produce. One row per agent
 * with its change, stage, lane and queue place; the header counts; the board updates live (the
 * demo plays a script: batch b_41 lands and fleet-coder-07 moves on to its next change); the repo
 * page and the palette open it, and the palette's agent hand gets list_changes. Roles, test ids
 * and demo data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

const MISSION = "/repos/repo_billing/mission";

test("mission control: one row per agent, each at its stage (demo data)", async ({
  authed: page,
}) => {
  await page.goto(`${MISSION}?mock&still`);
  const board = page.getByTestId("mission");
  await expect(board).toBeVisible();
  const rows = board.getByTestId("mission-row");
  await expect(rows).toHaveCount(8);
  for (const stage of ["grading", "lane", "review", "queued", "approved", "merged", "sent-back"]) {
    await expect(rows.and(page.locator(`[data-stage="${stage}"]`)).first()).toBeVisible();
  }
  const queued = rows.and(page.locator('[data-agent="fleet-coder-07"]'));
  await expect(queued).toHaveAttribute("data-stage", "queued");
  await expect(queued.locator('a[href="/changes/chg_tz7k2"]')).toBeVisible();
  await expect(page.getByTestId("mission-counts")).toBeVisible();
  await expect(page.getByTestId("mission-tracks")).toBeVisible();
  await expectNoHorizontalScroll(page);

  await queued.locator('a[href="/changes/chg_tz7k2"]').click();
  await expect(page).toHaveURL(/\/changes\/chg_tz7k2$/);
});

test("mission control: the board updates live as the queue lands a batch (demo data)", async ({
  authed: page,
}) => {
  // 22 s into the demo script: batch b_41 has passed, it lands at 26 s.
  await page.goto(`${MISSION}?mock&t=22`);
  const coder = page.getByTestId("mission-row").and(page.locator('[data-agent="fleet-coder-07"]'));
  await expect(coder).toHaveAttribute("data-stage", "merging");
  // Once it lands, the row moves on to the agent's next change closest to landing.
  await expect(coder.locator('a[href="/changes/chg_cm6t3"]')).toBeVisible({ timeout: 15_000 });
  await expect(coder).toHaveAttribute("data-stage", "queued");
});

test("mission control: from the repo page and the palette, with an agent twin (demo data)", async ({
  authed: page,
}) => {
  await page.goto("/repos/repo_billing?mock");
  await page.getByRole("link", { name: "Mission control" }).click();
  await expect(page).toHaveURL(new RegExp(`${MISSION}$`));
  await expect(page.getByTestId("mission")).toBeVisible();

  await page.goto("/repos/repo_billing?mock");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  const palette = page.getByTestId("palette");
  await palette.getByTestId("palette-mode-agent").click();
  await page.keyboard.type("mission");
  await expect(palette.getByTestId("palette-mcp")).toHaveText(
    'list_changes({ "repoId": "repo_billing" })',
  );
  await palette.getByTestId("palette-mode-me").click();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${MISSION}$`));
});
