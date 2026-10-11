/**
 * A new person learning the web app, on the real Worker: sign-in explains the loop in three
 * steps; the repo page lets a person start work ("What should change?" hands a prompt to their
 * agent, or, with another maintainer, drafts the Plan through POST /api/v1/plans), shows the
 * clone command and explains its words (<Term>); the palette's "Approve the plan…" lands on the
 * signing form; a private repo import shows the push command and waits for the push; /agents
 * prints the MCP setup, with the token filled in once one is made. Roles, test ids and seeded
 * data only (docs/testing.md).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";
import { signUp } from "../../lib/world.js";

test("sign-in: three steps in the day-one words instead of a lane chart", async ({ page }) => {
  await page.goto("/signin?mode=signup");
  const how = page.getByTestId("how-it-works");
  await expect(how.getByRole("heading", { name: "How it works" })).toBeVisible();
  await expect(how.getByRole("listitem").filter({ hasText: "Your agent drafts a Plan. You approve it." })).toBeVisible();
  await expect(how).toContainText("It builds a Change, with proof.");
  await expect(how).toContainText("You review only what needs you.");
  await expect(how).toContainText("Quick review");
  await expectNoHorizontalScroll(page);
});

test("repo: say what should change, get the agent's prompt; clone; terms explain themselves", async ({ authed: page, world, baseURL }) => {
  await page.goto(`/repos/${world.repoId}`);
  const intent = page.getByTestId("intent");
  await expect(intent.getByRole("heading", { name: "What should change?" })).toBeVisible();
  await intent.getByTestId("intent-text").fill("Show the tax line in the customer's currency.");
  await expect(intent.getByTestId("intent-prompt")).toHaveText(`Use ${baseURL}/start. In repo ${world.repoId}, draft a plan for: Show the tax line in the customer's currency.`);
  await expect(intent.getByRole("button", { name: "Copy prompt" })).toBeVisible();
  // A solo owner can't approve their own Plan: no "draft it yourself" without another maintainer.
  await expect(intent.getByTestId("intent-self")).toHaveCount(0);

  await expect(page.getByTestId("repo-clone")).toContainText(`npx -y ${baseURL}/cli/gittifacts.tgz clone ${world.repoId}`);
  // The seeded agent has an open Change here, so Mission control is offered.
  await expect(page.getByRole("link", { name: "Mission control" })).toBeVisible();

  const plans = page.locator('[data-term="plan"]').filter({ hasText: "Plans" });
  await plans.getByTestId("term").click();
  const card = plans.getByTestId("term-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("A person who didn't write it approves it");
  await expect(card.getByRole("link", { name: "More about plan" })).toHaveAttribute("href", "/docs/concepts/plans");
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("repo: an empty repo says what to tell the agent, and hides Mission control", async ({ authed: page, request, baseURL, human }) => {
  const res = await request.post(`${baseURL}/api/v1/repos`, { headers: { cookie: human.cookie, origin: baseURL as string }, data: { name: uniqueName("empty").toLowerCase() } });
  expect(res.ok(), await res.text()).toBe(true);
  const { repo } = (await res.json()) as { repo: { id: string } };
  await page.goto(`/repos/${repo.id}`);
  const empty = page.getByTestId("changes-empty");
  await expect(empty).toContainText("Tell your agent what should change");
  await expect(empty).not.toContainText("/api/v1");
  await expect(page.getByRole("link", { name: "Mission control" })).toHaveCount(0);
});

test("repo: with another maintainer, a person drafts the Plan themselves and someone else approves", async ({ authed: page, request, baseURL, human, world }) => {
  const other = await signUp(request, baseURL as string, "maint");
  const added = await request.post(`${baseURL}/api/v1/repos/${world.repoId}/members`, {
    headers: { cookie: human.cookie, origin: baseURL as string },
    data: { principalId: other.principalId, role: "maintainer" },
  });
  expect(added.ok(), await added.text()).toBe(true);

  await page.goto(`/repos/${world.repoId}`);
  const intent = page.getByTestId("intent");
  await intent.getByTestId("intent-text").fill("Invoices show the tax line in the customer's currency.");
  await intent.getByTestId("intent-self").click();
  const form = intent.getByTestId("intent-self-form");
  await expect(form).toContainText("Nobody approves their own Plan.");
  await form.getByTestId("intent-criteria").fill("A EUR customer sees the tax line in EUR\nTotals still add up");
  await form.getByTestId("intent-draft").click();
  await expect(page).toHaveURL(/\/plans\/[^/?#]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoices show the tax line in the customer's currency");
  await expect(page.getByRole("heading", { name: "You wrote this plan" })).toBeVisible();
});

test("palette: a person's 'Approve the plan…' lands on the signing form", async ({ authed: page, world }) => {
  await page.goto(`/plans/${world.planId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  const palette = page.getByTestId("palette");
  await palette.getByTestId("palette-mode-me").click();
  await palette.getByRole("combobox").fill("approve the plan");
  await expect(palette.locator('[data-command="plan.approve"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/plans/${world.planId}#sign$`));
  await expect(page.locator("#sign")).toBeInViewport();
  await expect(page.getByTestId("plan-approve")).toBeVisible();
});

test("dashboard: import a private repo shows the one-time push and waits for it", async ({ authed: page, request, baseURL, human }) => {
  await page.goto("/dashboard");
  await page.getByTestId("import-open-panel").click();
  const panel = page.getByTestId("import-repo");
  await panel.getByTestId("import-name").fill(uniqueName("private").toLowerCase());
  await panel.getByTestId("import-start").click();
  const cmd = panel.getByTestId("import-command");
  await expect(cmd).toContainText("export GITTIFACTS_IMPORT_TOKEN='");
  await expect(cmd).toContainText('git -c http.extraHeader="Authorization: Bearer $GITTIFACTS_IMPORT_TOKEN"');
  await expect(cmd).toContainText("main:refs/heads/main");
  await expect(panel.getByTestId("import-waiting")).toContainText("Waiting for your push");
  await expectNoHorizontalScroll(page);

  // The grant closing without a push (here: its owner closes it) ends the wait with a way back in.
  const id = await panel.getAttribute("data-repo-id");
  expect(id).toBeTruthy();
  const closed = await request.delete(`${baseURL}/api/v1/repos/${id}/import-grant`, { headers: { cookie: human.cookie, origin: baseURL as string } });
  expect(closed.ok(), await closed.text()).toBe(true);
  await expect(panel.getByRole("button", { name: "Open a new grant" })).toBeVisible({ timeout: 15_000 });
});

test("palette: importing a private repo is a person's, and lands on the import", async ({ authed: page }) => {
  await page.goto("/agents");
  await page.getByTestId("palette-open").filter({ visible: true }).first().click();
  const palette = page.getByTestId("palette");
  await palette.getByTestId("palette-mode-agent").click();
  await page.keyboard.type("import");
  await expect(palette.locator('[data-command="go.import"]')).toContainText("Only a person");
  await palette.getByTestId("palette-mode-me").click();
  await palette.getByRole("combobox").fill("import a private");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard#import$/);
  await expect(page.getByTestId("import-repo")).toBeVisible();
});

test("agents: copy-paste MCP setup, and the same with the token once one is made", async ({ authed: page, baseURL }) => {
  await page.goto("/agents");
  const connect = page.getByTestId("connect-agent");
  await expect(connect.getByTestId("mcp-snippet")).toHaveText(`claude mcp add --transport http gittifacts ${baseURL}/mcp`);
  await connect.getByRole("radio", { name: "Cursor, VS Code" }).click();
  expect(JSON.parse((await connect.getByTestId("mcp-snippet").textContent()) ?? "")).toEqual({ mcpServers: { gittifacts: { type: "http", url: `${baseURL}/mcp` } } });
  // Scopes read as words, with the raw id beside them.
  await expect(page.getByRole("list", { name: "What you may do" })).toContainText("Review Changes");

  const form = page.getByTestId("create-agent");
  await form.getByLabel("Name").fill(uniqueName("hand").toLowerCase().slice(0, 30));
  await form.getByRole("button", { name: "Create agent and token" }).click();
  const reveal = page.getByTestId("agent-token");
  await expect(reveal).toBeVisible();
  const token = ((await reveal.locator(".token__value").textContent()) ?? "").trim();
  expect(token).toMatch(/^gtf_/);
  await expect(reveal.getByTestId("mcp-snippet")).toHaveText(`claude mcp add --transport http gittifacts ${baseURL}/mcp --header "Authorization: Bearer ${token}"`);
  await expectNoHorizontalScroll(page);
});
