/**
 * The golden path from the dashboard's checklist, on the real Worker (DECISIONS 2026-10-11): a new
 * person creates a repo from a template, connects an agent, approves the sample plan the platform
 * drafted, has the agent build it, reviews the Change, and the merge queue lands it; each of the
 * five steps ticks from real state, and the last one shows the time from repo to merge. The agent's
 * part goes over HTTP with its token, as an MCP client would. Roles, test ids and seeded data only
 * (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { pollUntil, uniqueName } from "../../lib/poll.js";
import { seedCall } from "../../lib/world.js";

interface Checklist {
  plan: { planId: string; repoId: string; approved: boolean; sample: boolean } | null;
}

test("checklist: repo → agent → approve the sample plan → the agent builds it → review → first merge", async ({
  authed: page,
  request,
  baseURL,
  human,
}) => {
  // The merge queue polls its CI run every 15 s in wrangler dev: the landing takes real time.
  test.setTimeout(180_000);
  const origin = baseURL as string;
  const cookie = { cookie: human.cookie, origin };
  await page.goto("/dashboard");
  const checklist = page.getByTestId("first-run-checklist");
  const step = (id: string) => checklist.locator(`li[data-step="${id}"]`);
  await expect(checklist.locator("li[data-state]")).toHaveCount(5);
  await expect(step("repo")).toHaveAttribute("data-state", "todo");

  // 1. A repo from a template: it comes with a sample plan to approve.
  await step("repo").getByLabel("Template").selectOption("workers-api");
  await step("repo").getByRole("button", { name: "Create repo" }).click();
  await expect(step("repo")).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  const approveLink = step("plan").getByRole("link", { name: "Read and approve the plan" });
  await expect(approveLink).toBeVisible();
  const state = (await (
    await request.get(`${origin}/api/v1/me/getting-started`, { headers: cookie })
  ).json()) as Checklist;
  expect(state.plan).toMatchObject({ approved: false, sample: true });
  const { planId, repoId } = state.plan as NonNullable<Checklist["plan"]>;
  await expect(approveLink).toHaveAttribute("href", `/plans/${planId}`);

  // 2. Connect the agent: the MCP setup to paste; an agent token ticks it.
  await expect(step("agent").getByTestId("mcp-snippet")).toHaveText(
    `claude mcp add --transport http gittifacts ${origin}/mcp`,
  );
  await expectNoHorizontalScroll(page);
  const agentRes = await request.post(`${origin}/api/v1/principals/agents`, {
    headers: cookie,
    data: {
      name: uniqueName("agent").toLowerCase(),
      scopes: ["repo:read", "plan:create", "change:create"],
    },
  });
  expect(agentRes.status(), await agentRes.text()).toBe(201);
  const { token } = (await agentRes.json()) as { token: string };
  const agent = { authorization: `Bearer ${token}`, origin };

  // 3. Approve the plan (the platform drafted it; a person approves intent).
  await approveLink.click();
  await expect(page).toHaveURL(new RegExp(`/plans/${planId}$`));
  await page.getByTestId("plan-read").check();
  await page.getByTestId("plan-approve").click();
  await expect(page.getByTestId("plan-decided")).toHaveAttribute("data-status", "approved");
  await page.goto("/dashboard");
  await expect(step("agent")).toHaveAttribute("data-state", "done");
  await expect(step("plan")).toHaveAttribute("data-state", "done");
  await expect(step("review").getByTestId("gs-build-prompt")).toContainText(
    `Use ${origin}/start. In repo ${repoId}, build plan ${planId}.`,
  );

  // 4. The agent builds it: a Change on the plan, a push, CI, evidence, a lane.
  const started = await request.post(`${origin}/api/v1/changes`, {
    headers: agent,
    data: { repoId, planId, title: "Add GET /version", category: "feature" },
  });
  expect(started.status(), await started.text()).toBe(201);
  const { change } = (await started.json()) as { change: { id: string } };
  await seedCall(request, origin, "/__e2e/git/push", {
    forkName: `task-${change.id}`,
    files: {
      // Unique content: the fake git derives commit ids from it, and push workflows are keyed by them.
      "src/version.ts": `export const version = "0.0.0"; // ${uniqueName("v")}\n`,
      "test/version.test.ts":
        'import { version } from "../src/version";\n// GET /version returns it\n',
    },
  });
  const statusOf = async () => {
    const res = await request.get(`${origin}/api/v1/changes/${change.id}`, { headers: agent });
    return ((await res.json()) as { change: { status: string } }).change.status;
  };
  const finishCi = () =>
    seedCall<{ finished: string[] }>(request, origin, "/__e2e/ci/finish", { changeId: change.id });
  await pollUntil(
    async () => (await finishCi(), statusOf()),
    (s) => s === "awaiting-review",
    {
      timeoutMs: 45_000,
      what: "the agent's Change to await review",
    },
  );

  // 5. Review: the checklist links the Change; approving it sends it to the merge queue.
  await page.reload();
  await step("review").getByRole("link", { name: "Review the Change" }).click();
  await expect(page).toHaveURL(new RegExp(`/changes/${change.id}$`));
  const approve = page.getByTestId("decision-approve").first();
  await approve.scrollIntoViewIfNeeded();
  await approve.click();
  await page.getByTestId("decision-confirm").click();
  await expect(page.getByTestId("decision-done")).toHaveAttribute("data-decision", "approve");
  await pollUntil(
    async () => (await finishCi(), statusOf()),
    (s) => ["merged", "rolling-out", "released"].includes(s),
    {
      timeoutMs: 90_000,
      what: "the merge queue to land the Change",
    },
  );

  // All five done: one slim line with the time from repo to merge.
  await page.goto("/dashboard");
  const banner = page.locator(".gs-banner");
  await expect(banner).toContainText("Add GET /version");
  await expect(banner).toContainText("after the repo was created");
  await expect(checklist).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
