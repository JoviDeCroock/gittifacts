/**
 * The human's review journey on seeded data, through the real Worker and D1: the dashboard and
 * its first-run checklist, a Change's walkthrough and evidence, approving the Change, approving a
 * Plan, and the repo's merge queue. Assertions use roles, test ids and the seeded data, never copy
 * that is being renamed.
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { pollUntil } from "../../lib/poll.js";

test("dashboard: the first-run checklist and the human's repo", async ({ authed: page, world }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const checklist = page.getByTestId("first-run-checklist");
  await expect(checklist).toBeVisible();
  await expect(checklist.locator("li[data-state]")).toHaveCount(5);
  // The seeded repo makes "Create a repo" done from real state.
  await expect(checklist.locator('li[data-state="done"]')).not.toHaveCount(0);
  const repoLink = page
    .getByRole("main")
    .getByRole("link", { name: new RegExp(world.repoName) })
    .first();
  await expect(repoLink).toBeVisible();
  await expectNoHorizontalScroll(page);
  await repoLink.click();
  await expect(page).toHaveURL(new RegExp(`/repos/${world.repoId}$`));
  await expect(page.getByRole("link", { name: /Rate limit logins/ }).first()).toBeVisible();
});

test("change: evidence page verifies the platform's signature", async ({
  authed: page,
  world,
  request,
  baseURL,
  human,
}) => {
  await page.goto(`/changes/${world.changeId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Rate limit logins" })).toBeVisible();
  await expect(page.getByText("src/auth/login.ts").first()).toBeVisible();
  await page.goto(`/changes/${world.changeId}/evidence`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("verify-attestation", { exact: false }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  const ev = await request.get(`${baseURL}/api/v1/changes/${world.changeId}/evidence`, {
    headers: { cookie: human.cookie },
  });
  expect(((await ev.json()) as { verification: { ok: boolean } }).verification.ok).toBe(true);
});

test("agent push → walkthrough → the owner approves → the merge queue takes it", async ({
  authed: page,
  agentWork,
  request,
  baseURL,
}) => {
  await page.goto(`/changes/${agentWork.changeId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Approve: the button opens the confirmation; confirming records the decision.
  const approve = page.getByTestId("decision-approve").first();
  await approve.scrollIntoViewIfNeeded();
  await approve.click();
  await page.getByTestId("decision-confirm").click();
  await expect(page.getByTestId("decision-done")).toHaveAttribute("data-decision", "approve");
  // The decision reached the server: the Change moves past review (approved / queued / merged).
  const auth = { authorization: `Bearer ${agentWork.agentToken}` };
  await pollUntil(
    async () => {
      const res = await request.get(`${baseURL}/api/v1/changes/${agentWork.changeId}`, {
        headers: auth,
      });
      return ((await res.json()) as { change: { status: string } }).change.status;
    },
    (status) => status !== "awaiting-review",
    { timeoutMs: 20_000, what: "the Change to leave awaiting-review after approval" },
  );
});

test("plan: read, sign and approve", async ({ authed: page, world, request, baseURL, human }) => {
  await page.goto(`/plans/${world.planId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const submit = page.getByTestId("plan-approve");
  await expect(submit).toBeDisabled();
  await page.getByTestId("plan-read").check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId("plan-decided")).toHaveAttribute("data-status", "approved");
  const res = await request.get(`${baseURL}/api/v1/plans/${world.planId}`, {
    headers: { cookie: human.cookie },
  });
  const body = (await res.json()) as { plan: { status: string; approvedBy: string | null } };
  expect(body.plan).toMatchObject({ status: "approved", approvedBy: human.principalId });
  await expectNoHorizontalScroll(page);
});

test("merge queue: the repo's queue renders its state", async ({ authed: page, world }) => {
  await page.goto(`/repos/${world.repoId}/queue`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
