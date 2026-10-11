/**
 * The repo, merge queue and members screens (UX review 2026-10-11, W-D2): a reviewer takes an entry
 * out of the queue from the page (named confirmation first, the agent twin beside it); Remove on
 * Members acts only after an inline confirmation names it; the repo's title is its name from the
 * first frame, never "Repository". Roles, test ids and seeded data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { signUp } from "../../lib/world.js";

test("queue: a reviewer dequeues an entry after a named confirmation, and it leaves the queue (demo data)", async ({ authed: page }) => {
  // The hermetic server has no busy queue; the UI's demo backend has one and the demo viewer reviews.
  await page.goto("/repos/repo_billing/queue?mock");
  const entry = page.locator('[data-testid="queue-entry"][data-change-id="chg_tz7k2"]');
  await expect(entry).toHaveAttribute("data-state", "speculating");
  const count = page.locator("#q-entries .q-count");
  const before = Number(await count.textContent());

  await entry.getByTestId("queue-dequeue").click();
  // The first click only opens the confirmation: nothing has left yet.
  const confirm = entry.getByTestId("queue-dequeue-confirm");
  await expect(confirm).toBeVisible();
  await expect(entry.getByRole("group", { name: /Dequeue Fix invoice due dates/ })).toContainText("out of the merge queue");
  await expect(entry.getByText('dequeue({ changeId: "chg_tz7k2" })')).toBeVisible();
  await expect(entry).toHaveAttribute("data-state", "speculating");

  await confirm.click();
  await expect(page.getByTestId("queue-notice")).toContainText("out of the queue");
  await expect(page.locator('[data-testid="queue-entry"][data-change-id="chg_tz7k2"]')).toHaveAttribute("data-state", "dequeued");
  await expect(count).toHaveText(String(before - 1));
  await expectNoHorizontalScroll(page);
});

test("queue: an owner resumes a halted queue from its banner (demo data)", async ({ authed: page }) => {
  await page.goto("/repos/repo_billing/queue?mock&halted");
  const halted = page.getByTestId("queue-halted");
  await expect(halted).toBeVisible();
  await halted.getByTestId("queue-resume").click();
  await expect(halted.getByText("Only a person resumes a halted queue")).toBeVisible();
  await halted.getByTestId("queue-resume-confirm").click();
  await expect(page.getByTestId("queue-halted")).toHaveCount(0);
  await expect(page.getByTestId("queue-notice")).toContainText("Queue resumed");
});

test("members: Remove needs an inline confirmation that names the person", async ({ authed: page, world, request, baseURL }) => {
  const other = await signUp(request, baseURL as string, "e2e-member");
  await page.goto(`/repos/${world.repoId}/members`);
  await page.getByLabel("E-mail").fill(other.email);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.locator(`[data-testid="member"][data-principal="${other.principalId}"]`);
  await expect(row).toBeVisible();

  await row.getByTestId("member-remove").click();
  const confirm = row.getByTestId("member-confirm");
  await expect(confirm).toContainText(`Remove ${other.name} from ${world.repoName}?`);
  // Still a member until the named action is pressed.
  await expect(row).toBeVisible();
  await expect(row.getByTestId("member-confirm-act")).toHaveText(`Remove ${other.name}`);
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  await row.getByTestId("member-remove").click();
  await row.getByTestId("member-confirm-act").click();
  await expect(page.locator(`[data-testid="member"][data-principal="${other.principalId}"]`)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: `Removed ${other.name}.` })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("repo: the title is the repo's name from the first frame of an in-app navigation", async ({ authed: page, world }) => {
  await page.goto("/dashboard");
  const link = page.locator(`a[href="/repos/${world.repoId}"]`).filter({ visible: true }).first();
  await expect(link).toBeVisible();
  // The sidebar's list (in the DOM on phones too) is where the name comes from.
  await expect(page.getByTestId("nav-repo").filter({ hasText: world.repoName }).first()).toBeAttached();
  // Record every h1 and tab title the navigation renders, loading frames included.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __titles: string[] }).__titles = seen;
    new MutationObserver(() => {
      seen.push(document.querySelector("h1")?.textContent ?? "", document.title);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await link.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(world.repoName);
  const titles = await page.evaluate(() => (window as unknown as { __titles: string[] }).__titles);
  expect(titles.filter((t) => /^Repository\b/.test(t))).toEqual([]);
});
