/**
 * A person browses a repo's code and history through the real Worker (Artifacts is the fake git
 * host): from the repo's tabs to Code (directories first, the README rendered), into a directory
 * and a file, to Commits (grouped by day, the agent's commit naming the Change that landed it),
 * one commit's diff, and Activity (the calendar, its readout and the table view). Desktop and
 * phone; nothing scrolls the page sideways.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";
import { type Human, seedCall } from "../../lib/world.js";

const README = "# Ledger\n\nSplits the bill.\n\n- **Fair** to the cent\n- Runs on `workers`\n";

async function repoWithHistory(request: APIRequestContext, baseURL: string, human: Human) {
  const headers = { cookie: human.cookie, origin: baseURL };
  const name = uniqueName("code").toLowerCase();
  const created = await request.post(`${baseURL}/api/v1/repos`, { headers, data: { name } });
  expect(created.status()).toBe(201);
  const { repo } = (await created.json()) as { repo: { id: string; artifactsName: string } };
  const ada = { name: "Ada", email: "ada@example.test" };
  const history = (commits: unknown[]) =>
    seedCall<{ shas: string[] }>(request, baseURL, "/__e2e/git/history", {
      artifactsName: repo.artifactsName,
      commits,
    });
  // The root commit first: starting a Change forks the default branch.
  await history([
    {
      message: "Initial commit",
      author: ada,
      daysAgo: 20,
      files: {
        "README.md": README,
        "src/money.ts": "export const round = (n: number) => Math.round(n);\n",
        "src/lib/cents.ts": "export const CENTS = 100;\n",
      },
    },
  ]);
  const agent = await request.post(`${baseURL}/api/v1/principals/agents`, {
    headers,
    data: {
      name: uniqueName("forge").toLowerCase(),
      scopes: ["repo:read", "plan:create", "change:create"],
    },
  });
  expect(agent.status()).toBe(201);
  const { token } = (await agent.json()) as { token: string };
  const started = await request.post(`${baseURL}/api/v1/changes`, {
    headers: { authorization: `Bearer ${token}`, origin: baseURL },
    data: { repoId: repo.id, title: "Round totals half up", category: "fix" },
  });
  expect(started.status()).toBe(201);
  const { change } = (await started.json()) as { change: { id: string } };
  const { shas } = await history([
    { message: "Add notes", author: ada, daysAgo: 2, files: { "docs/notes.md": "notes\n" } },
    {
      message: "Round totals half up",
      author: { name: "forge", email: "forge@agents.test" },
      daysAgo: 0.01,
      landsChangeId: change.id,
      files: { "src/money.ts": "export const round = (n: number) => Math.floor(n + 0.5);\n" },
    },
  ]);
  return { repoId: repo.id, repoName: name, changeId: change.id, landed: shas[1] as string };
}

test("code and history: tree, README, a file, commits, a commit and activity", async ({
  authed: page,
  request,
  baseURL,
  human,
}) => {
  const r = await repoWithHistory(request, baseURL as string, human);
  await page.goto(`/repos/${r.repoId}`);
  const tabs = page.getByRole("navigation", { name: "Repository" });
  await expect(tabs.getByRole("link", { name: "Changes" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Code" }).click();

  // The root: directories first, the README rendered as Markdown (not raw text).
  await expect(page).toHaveURL(new RegExp(`/repos/${r.repoId}/tree$`));
  const list = page.getByTestId("tree-list");
  // The platform scaffolds AGENTS.md and .platform/ when it creates a repo.
  await expect(list.getByRole("link")).toHaveText([
    ".platform",
    "docs",
    "src",
    "AGENTS.md",
    "README.md",
  ]);
  const readme = page.getByTestId("readme");
  await expect(readme.getByRole("heading", { name: "Ledger" })).toBeVisible();
  await expect(readme.locator("strong")).toHaveText("Fair");
  await expect(page.getByTestId("last-commit")).toContainText("Round totals half up");
  await expectNoHorizontalScroll(page);

  // Into src/, then the file.
  await list.getByRole("link", { name: "src" }).click();
  await expect(page).toHaveURL(new RegExp(`/repos/${r.repoId}/tree/src$`));
  await expect(page.getByTestId("tree-list").getByRole("link")).toHaveText([
    /^\.\./,
    "lib",
    "money.ts",
  ]);
  await page.getByTestId("tree-list").getByRole("link", { name: "money.ts" }).click();
  await expect(page).toHaveURL(new RegExp(`/repos/${r.repoId}/blob/src/money.ts$`));
  await expect(page.getByRole("heading", { level: 1, name: "money.ts" })).toBeVisible();
  await expect(page.getByTestId("code-view")).toContainText("Math.floor(n + 0.5)");
  await expectNoHorizontalScroll(page);

  // Commits: grouped by day; the agent's commit names the Change that landed it.
  await page
    .getByRole("navigation", { name: "Repository" })
    .getByRole("link", { name: "Commits" })
    .click();
  const commits = page.getByTestId("commit-list");
  const titles = commits.locator(".commit-row__title");
  await expect(titles).toHaveCount(4);
  await expect(titles.nth(0)).toHaveText("Round totals half up");
  await expect(titles.nth(1)).toHaveText("Add notes");
  await expect(titles.nth(2)).toHaveText("Initial commit");
  await expect(commits.getByRole("link", { name: /via its Change/ })).toHaveAttribute(
    "href",
    `/changes/${r.changeId}`,
  );
  await expectNoHorizontalScroll(page);

  // One commit: the Change that landed it and its diff.
  await commits.getByRole("link", { name: "Round totals half up" }).click();
  await expect(page).toHaveURL(new RegExp(`/repos/${r.repoId}/commits/${r.landed}$`));
  await expect(page.getByTestId("landed-by")).toContainText("Round totals half up");
  const diff = page.getByTestId("commit-diff");
  await expect(diff.getByRole("heading")).toContainText("1 file changed");
  await expect(diff).toContainText("Math.floor(n + 0.5)");
  await expectNoHorizontalScroll(page);

  // Activity: 4 commits in six months (the scaffold too), a readout for a day, the table view.
  await page
    .getByRole("navigation", { name: "Repository" })
    .getByRole("link", { name: "Activity" })
    .click();
  await expect(page.getByTestId("activity-totals")).toContainText("4");
  // Today (UTC): the scaffold and the landed commit.
  const today = new Date().toISOString().slice(0, 10);
  await page.locator(`.calendar__cell[data-date="${today}"]`).click();
  await expect(page.getByTestId("activity-readout")).toHaveText(/^2 commits on /);
  await page.getByText("Commits per week as a table").click();
  await expect(page.locator(".activity-table tbody tr").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});
