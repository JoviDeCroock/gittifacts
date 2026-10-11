/**
 * The review journey's side screens (UX audit 2026-10-11, findings 18-25):
 *
 * - plan: the author of a draft can share it and withdraw it (real Worker: POST /plans/:id/withdraw);
 *   on a phone the "Review and sign" bar steps aside once the signing panel is on screen and the
 *   jump puts focus on the attestation;
 * - evidence: the index opens with what needs a person's judgment and marks the item in view;
 * - rollout: the state line is the h1, the live region speaks to the minute (never per second),
 *   and timeline rows say the stage and who acted, each row one target.
 *
 * States the hermetic server can't produce (a rollout in flight, signed evidence with screenshots, a
 * plan someone else drafted) come from the UI's demo backend (`?mock`). Roles, test ids and seeded
 * data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";

test("plan: the author of a draft copies its link or withdraws it, and the server records the withdrawal", async ({ authed: page, request, baseURL, human, world }) => {
  const created = await request.post(`${baseURL}/api/v1/plans`, {
    headers: { cookie: human.cookie, origin: baseURL as string },
    data: {
      repoId: world.repoId,
      title: "Withdraw me: a draft its author changes their mind about",
      intent: "A draft plan the author withdraws from the plan page before anyone signs it.",
      acceptanceCriteria: ["The draft ends withdrawn"],
      scopePaths: ["src/**"],
    },
  });
  expect(created.status(), `draft a plan: ${await created.text()}`).toBe(201);
  const { plan } = (await created.json()) as { plan: { id: string } };

  await page.goto(`/plans/${plan.id}`);
  const own = page.getByTestId("plan-own-draft");
  await expect(own).toBeVisible();
  await expect(own.getByRole("button", { name: "Copy link" })).toBeVisible();
  // Nobody signs their own plan: no signing panel, and no phone bar pointing at one.
  await expect(page.getByTestId("plan-approve")).toHaveCount(0);
  await expect(page.getByTestId("plan-bar")).toHaveCount(0);

  // The confirmation names the act; Back returns focus to where it came from.
  await page.getByTestId("plan-withdraw").click();
  await expect(page.getByTestId("plan-withdraw-form")).toBeVisible();
  await page.getByTestId("plan-withdraw-form").getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("plan-withdraw")).toBeFocused();

  await page.getByTestId("plan-withdraw").click();
  await page.getByTestId("plan-withdraw-form").getByRole("textbox").fill("Folded into a bigger plan.");
  await page.getByTestId("plan-withdraw-confirm").click();
  const decided = page.getByTestId("plan-decided");
  await expect(decided).toHaveAttribute("data-status", "rejected");
  await expect(decided.getByRole("heading", { level: 2 })).toBeFocused();
  await expectNoHorizontalScroll(page);

  const after = await request.get(`${baseURL}/api/v1/plans/${plan.id}`, { headers: { cookie: human.cookie } });
  expect(((await after.json()) as { plan: { status: string } }).plan.status).toBe("rejected");
});

test("plan: on a phone the signing bar steps aside at the panel and focus lands on the attestation (demo data)", async ({ authed: page }, testInfo) => {
  // plan_dunning: an agent's draft the demo viewer may sign.
  await page.goto("/plans/plan_dunning?mock");
  await expect(page.getByTestId("plan-approve")).toBeAttached();
  const bar = page.getByTestId("plan-bar");
  if (testInfo.project.name !== "phone") {
    // From 1100px the rail holds the signing panel beside the plan.
    await expect(bar).toHaveCount(0);
    return;
  }
  await expect(bar).toBeInViewport();
  await page.getByTestId("plan-jump-to-sign").click();
  await expect(page.getByTestId("plan-read")).toBeFocused();
  await expect(bar).toHaveAttribute("data-aside", "");
  await expect(bar).toBeHidden();
  await expectNoHorizontalScroll(page);
});

test("evidence: the index says what needs judgment and marks the item in view (demo data)", async ({ authed: page }) => {
  await page.goto("/changes/chg_tz7k2/evidence?mock");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Evidence for");
  const index = page.getByTestId("evidence-index");
  const flagged = page.getByTestId("evidence-flagged");
  await expect(flagged.getByRole("link")).toHaveCount(1);
  await flagged.getByRole("link").click();
  await expect(page.locator("#ev-mutation")).toBeInViewport();
  const current = index.locator('li a[aria-current="location"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", "#ev-mutation");
  // Only the signed pixel-difference figure is spoken; the browser's own count is not repeated.
  await expect(page.locator("#ev-screenshots .sr-only", { hasText: "pixels" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("rollout: the state is the title, spoken to the minute, and each timeline row says the stage and who acted (demo data)", async ({ authed: page }, testInfo) => {
  await page.goto("/changes/chg_fx2r7/rollout?mock");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Rolling out to \d+% of traffic$/);

  // One live region, and it does not change with the per-second countdown.
  const live = page.locator("main [aria-live]");
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute("data-testid", "rollout-live");
  const spoken = await live.textContent();
  await page.waitForTimeout(2_100);
  expect(await live.textContent()).toBe(spoken);

  const rows = page.getByTestId("rollout-timeline-row");
  await expect(rows.filter({ hasText: /Moved to \d+%/ })).toHaveCount(1);
  // The agent that opened the change is a square with its person.
  await expect(rows.filter({ hasText: "agent of" }).first()).toBeVisible();
  const row = rows.filter({ hasText: /Moved to \d+%/ }).getByRole("link");
  await expect(row).toHaveAttribute("href", /^\/audit\?subject=change%3Achg_fx2r7$/);
  if (testInfo.project.name === "phone") {
    const box = await row.boundingBox();
    expect(box?.height ?? 0, "timeline row target height in px").toBeGreaterThanOrEqual(43.5);
  }
  await expectNoHorizontalScroll(page);
});
