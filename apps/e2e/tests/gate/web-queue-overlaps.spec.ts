/**
 * Overlapping work in the merge queue (demo data: the hermetic server can't produce a busy queue).
 * Two agents' changes in batch b_41 both edit src/billing/format.ts: each entry carries a quiet
 * note naming the other change and its agent, with the shared path, linking to that change.
 * Roles, test ids and demo data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

test("merge queue: an entry that overlaps another open change says so and links to it (demo data)", async ({
  authed: page,
}) => {
  await page.goto("/repos/repo_billing/queue?mock");
  const entry = page
    .locator(".q-entry")
    .filter({ has: page.locator('a.q-entry__title[href="/changes/chg_lc3m9"]') });
  const note = entry.getByTestId("queue-overlap");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("fleet-coder-07");
  await expect(note.locator("code")).toHaveText("src/billing/format.ts");
  await expectNoHorizontalScroll(page);
  await note.getByRole("link").click();
  await expect(page).toHaveURL(/\/changes\/chg_tz7k2$/);
});
